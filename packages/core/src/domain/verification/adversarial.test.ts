/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { classifyTest, parseAdversarialManifest, survival, testGate, type AdversarialTest } from './adversarial.js';
import type { GatePlan } from './gates.js';

const exists = (path: string) => ['a.test.js', 'test/b.test.js', 'sum.js'].includes(path);

describe('parseAdversarialManifest', () => {
  it('should keep tests whose files are existing test files and that name a clause', () => {
    const text = JSON.stringify({ tests: [{ files: ['a.test.js'], specClause: ' rejects non-numbers ' }, { files: ['./test/b.test.js'], specClause: 'adds' }] });
    expect(parseAdversarialManifest(text, exists)).toEqual({
      tests: [{ files: ['a.test.js'], specClause: 'rejects non-numbers' }, { files: ['test/b.test.js'], specClause: 'adds' }],
      notes: [],
    });
  });

  it('should drop each bad entry by name', () => {
    const text = JSON.stringify({ tests: [
      { files: ['a.test.js'] },
      { files: [], specClause: 'x' },
      { files: ['sum.js'], specClause: 'x' },
      { files: ['../a.test.js'], specClause: 'x' },
      { files: ['/tmp/a.test.js'], specClause: 'x' },
      { files: ['c.test.js'], specClause: 'x' },
      'nonsense',
    ] });
    const { tests, notes } = parseAdversarialManifest(text, exists);
    expect(tests).toEqual([]);
    expect(notes).toEqual([
      'tests[0] dropped: names no specClause',
      'tests[1] dropped: lists no files',
      'tests[2] dropped: sum.js is not a test file',
      'tests[3] dropped: ../a.test.js is outside the worktree',
      'tests[4] dropped: /tmp/a.test.js is outside the worktree',
      'tests[5] dropped: c.test.js does not exist',
      'tests[6] dropped: names no specClause',
    ]);
  });

  it('should reject a manifest that is not JSON or has no tests list, and keep at most the limit', () => {
    expect(parseAdversarialManifest('{', exists).notes[0]).toMatch(/^concilium-adversarial\.json is not JSON/);
    expect(parseAdversarialManifest('{"files": []}', exists).notes).toEqual(['concilium-adversarial.json has no "tests" list']);
    const many = JSON.stringify({ tests: Array.from({ length: 4 }, (_, i) => ({ files: ['a.test.js'], specClause: `c${i}` })) });
    const { tests, notes } = parseAdversarialManifest(many, exists, 2);
    expect(tests.map((t) => t.specClause)).toEqual(['c0', 'c1']);
    expect(notes).toEqual(['2 tests over the limit of 2 dropped']);
  });
});

describe('classifyTest', () => {
  it.each([
    ['fail', ['pass', 'fail'], 'bugfix', 'evidence'],
    ['fail', ['fail', 'error'], 'feature', 'quarantined'],
    ['pass', ['pass', 'fail'], 'bugfix', 'vacuous'],
    ['pass', ['pass', 'fail'], 'feature', 'regression-guard'],
    ['pass', ['pass'], 'refactor', 'regression-guard'],
    ['error', ['pass'], 'feature', 'unrunnable'],
  ] as const)('should call a test that is %s on the base and %j on the candidates of a %s %s', (base, candidates, type, validity) => {
    expect(classifyTest(base, [...candidates], type)).toBe(validity);
  });
});

describe('survival', () => {
  it('should count only valid tests by other families, and a non-pass as a failure', () => {
    const test = (id: string, author: string, validity: AdversarialTest['validity']): AdversarialTest => ({ id, author, validity, files: [`${id}.test.js`], specClause: 'c' });
    const tests = [test('a-1', 'anthropic', 'evidence'), test('a-2', 'anthropic', 'regression-guard'), test('a-3', 'anthropic', 'quarantined'), test('o-1', 'openai', 'evidence')];
    const matrix = {
      'a-1': { base: 'fail', claude: 'pass', codex: 'fail' },
      'a-2': { base: 'pass', claude: 'pass', codex: 'error' },
      'a-3': { base: 'fail', claude: 'fail', codex: 'fail' },
      'o-1': { base: 'fail', claude: 'pass', codex: 'pass' },
    } as const;
    expect(survival(tests, matrix, [{ candidateId: 'claude', family: 'anthropic' }, { candidateId: 'codex', family: 'openai' }])).toEqual({
      claude: { counted: 1, survived: 1, failed: [] },
      codex: { counted: 2, survived: 0, failed: ['a-1', 'a-2'] },
    });
  });
});

describe('testGate', () => {
  it('should pick the test gate of any ecosystem, or none', () => {
    const plan = (...names: string[]): GatePlan => ({ source: 'detected', install: null, notes: [], gates: names.map((name) => ({ name, command: name, timeoutMs: 1 })) });
    expect(testGate(plan('npm:lint', 'npm:test'))?.name).toBe('npm:test');
    expect(testGate(plan('lint', 'test'))?.name).toBe('test');
    expect(testGate(plan('go:vet', 'go:test'))?.name).toBe('go:test');
    expect(testGate(plan('pytest'))?.name).toBe('pytest');
    expect(testGate(plan('lint', 'contest'))).toBeUndefined();
  });
});
