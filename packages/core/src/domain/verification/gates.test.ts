/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { detectGates, GATE_TIMEOUT_MS, judgeGates, parseVerifyConfig, planGates, type GateResult } from './gates.js';

function tree(files: Record<string, string>) {
  return (path: string) => files[path] ?? null;
}

function result(name: string, outcome: GateResult['outcome']): GateResult {
  return { name, command: name, sha: 'abc', outcome, exitCode: outcome === 'pass' ? 0 : 1, durationMs: 1, output: '', truncated: false };
}

describe('detectGates', () => {
  it('should find the typecheck, lint and test package.json scripts in that order, and nothing else', () => {
    const read = tree({ 'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' } }) });
    expect(detectGates(read).map((g) => [g.name, g.command])).toEqual([
      ['npm:typecheck', 'npm run typecheck'],
      ['npm:lint', 'npm run lint'],
      ['npm:test', 'npm run test'],
    ]);
  });

  it('should find Makefile targets, go vet and go test, pytest and cargo test', () => {
    const read = tree({
      Makefile: 'VERSION := 1\n.PHONY: lint test\nlint test: deps\n\tgo vet\nbuild:\n\tgo build\n',
      'go.mod': 'module example.com/x\n',
      'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n',
      'Cargo.toml': '[package]\nname = "x"\n',
    });
    expect(detectGates(read).map((g) => g.command)).toEqual(['make lint', 'make test', 'go vet ./...', 'go test ./...', 'python -m pytest', 'cargo test']);
    expect(detectGates(read).every((g) => g.timeoutMs === GATE_TIMEOUT_MS)).toBe(true);
  });

  it('should find no gates in a repo without any, or with a package.json that does not parse', () => {
    expect(detectGates(tree({ 'README.md': '# x' }))).toEqual([]);
    expect(detectGates(tree({ 'package.json': '{ not json' }))).toEqual([]);
    expect(detectGates(tree({ 'pyproject.toml': '[project]\nname = "x"\n' }))).toEqual([]);
  });
});

describe('planGates', () => {
  it('should install with npm ci only when there is a lockfile, skipped when node_modules exists', () => {
    expect(planGates(tree({ 'package.json': '{}' })).install).toBeNull();
    expect(planGates(tree({ 'package.json': '{}', 'package-lock.json': '{}' })).install).toMatchObject({ command: 'npm ci', skipIfExists: 'node_modules' });
  });

  it('should let .concilium/verify.yaml replace the detected gates and the install step', () => {
    const plan = planGates(tree({
      'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
      'package-lock.json': '{}',
      '.concilium/verify.yaml': 'install: false\ngates:\n  unit: node test.js\n  lint:\n    run: node lint.js\n    timeout: 30\n',
    }));
    expect(plan).toEqual({
      source: 'verify.yaml',
      install: null,
      notes: [],
      gates: [
        { name: 'unit', command: 'node test.js', timeoutMs: GATE_TIMEOUT_MS },
        { name: 'lint', command: 'node lint.js', timeoutMs: 30_000 },
      ],
    });
  });

  it('should keep the detected gates when verify.yaml sets only the install step', () => {
    const plan = planGates(tree({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }), '.concilium/verify.yaml': 'install: make deps\n' }));
    expect(plan.gates.map((g) => g.name)).toEqual(['npm:test']);
    expect(plan.install).toMatchObject({ command: 'make deps' });
    expect(plan.install?.skipIfExists).toBeUndefined();
  });

  it('should fall back to detection with a note when verify.yaml is invalid', () => {
    const plan = planGates(tree({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }), '.concilium/verify.yaml': 'gates:\n  unit:\n    timeout: 5\n' }));
    expect(plan.source).toBe('detected');
    expect(plan.gates.map((g) => g.name)).toEqual(['npm:test']);
    expect(plan.notes).toEqual(['.concilium/verify.yaml ignored, using detected gates: gates.unit: must be a command, or have a "run" command']);
  });
});

describe('parseVerifyConfig', () => {
  it.each([
    ['- a list', 'must be a mapping'],
    ['gate:\n  test: x\n', 'unknown key "gate" (use gates and install)'],
    ['gates: [a, b]\n', 'gates: must map gate names to commands'],
    ['install: 3\n', 'install: must be a command or false'],
    ['gates:\n  t:\n    run: x\n    timeout: -1\n', 'gates.t.timeout: must be a positive number of seconds'],
  ])('should reject %j', (text, message) => {
    expect(() => parseVerifyConfig(text)).toThrow(message);
  });
});

describe('judgeGates', () => {
  it('should hold only failures the base does not have against a candidate', () => {
    const base = [result('test', 'pass'), result('lint', 'fail'), result('types', 'pass')];
    const candidate = [result('test', 'fail'), result('lint', 'fail'), result('types', 'timeout')];
    expect(judgeGates(base, candidate).map((g) => [g.name, g.verdict])).toEqual([
      ['test', 'new-failure'],
      ['lint', 'baseline-failure'],
      ['types', 'new-failure'],
    ]);
    expect(judgeGates(base, [result('lint', 'pass')])[0].verdict).toBe('pass');
  });
});
