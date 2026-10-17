/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CliDetection } from '../ports/headless-cli-driver.js';
import { FakeCliDriver } from '../adapters/cli/fake-cli-driver.js';
import { setLogLevel } from '../shared/logger.js';
import { approveGate, listGates } from './action-gate.js';
import type { CodeRunRecord } from './code-service.js';
import { prStatus, requestPr, verifyPr } from './pr-service.js';

const sandbox = mkdtempSync(join(tmpdir(), 'concilium-pr-'));
writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
const runsDir = join(sandbox, 'runs');

const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => {
  setLogLevel('error');
  process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();
}

const RUN_TESTS = "for (const f of require('fs').readdirSync('.').filter((f) => f.endsWith('.test.js'))) require('./' + f);\n";
const ADVERSARIAL_TEST = "let ok = false; try { require('./sum.js')('x', 1); } catch (e) { ok = e instanceof TypeError; } if (!ok) throw new Error('no TypeError');\n";

/**
 * A repo whose integration branch is the `claude` base plus a graft from `codex`, folded in by `claude`, and an
 * `adv-google`-style adversary branch holding a valid test. `fixed` decides whether the integration head passes it.
 */
function setup(name: string, fixed: boolean): { repo: string; record: CodeRunRecord; runDir: string } {
  const repo = join(sandbox, name);
  const runId = `${name}-run`;
  git(sandbox, 'init', '-q', repo);
  writeFileSync(join(repo, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'run-tests.js'), RUN_TESTS);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const baseSha = git(repo, 'rev-parse', 'HEAD');

  const branch = `concilium/${runId}/integration`;
  git(repo, 'checkout', '-q', '-b', branch);
  writeFileSync(join(repo, 'sum.js'), fixed ? 'module.exports = (a, b) => { if (typeof a !== "number") throw new TypeError("a"); return a + b; };\n' : 'module.exports = (a, b) => b + a;\n');
  git(repo, 'commit', '-q', '-am', 'claude candidate');
  writeFileSync(join(repo, 'notes.md'), 'grafted\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'graft-1');
  const graftSha = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'checkout', '-q', '-b', `concilium/${runId}/adv-openai`, baseSha);
  writeFileSync(join(repo, 'openai-1.test.js'), ADVERSARIAL_TEST);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'adversarial test');
  const advSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');

  const record = {
    version: 1, kind: 'code', id: runId, status: 'done', task: 'sum rejects non-numbers', repoDir: repo, headSha: baseSha, baseSha,
    dissent: { path: null, records: [] },
    candidates: [{ candidateId: 'claude', provider: 'claude' }, { candidateId: 'codex', provider: 'codex' }],
    verification: {
      plan: { source: 'detected', gates: [{ name: 'test', command: 'node run-tests.js', timeoutMs: 60_000 }], install: null, notes: [] },
      baseline: { lane: 'base', sha: baseSha, install: null, gates: [{ name: 'test', outcome: 'pass' }] },
      errors: [],
    },
    adversarial: {
      testCommand: 'node run-tests.js', matrix: {}, survival: {}, runs: [],
      adversaries: [{ family: 'openai', provider: 'codex', lane: 'adv-openai', headSha: advSha }],
      tests: [{ id: 'openai-1', author: 'openai', files: ['openai-1.test.js'], specClause: 'reject non-numbers', validity: 'evidence' }],
    },
    synthesis: {
      base: { candidateId: 'claude', headSha: baseSha, reason: 'best' }, branch, worktree: null, headSha: graftSha, picker: null, notes: [],
      grafts: [{ id: 'graft-1', candidateId: 'codex', commitSha: graftSha, status: 'applied', integrator: { provider: 'claude' } }],
      dropouts: [], checks: null, patchPath: null, synthesisPath: null, mergeable: true, mergeCheck: null,
    },
  } as unknown as CodeRunRecord;
  return { repo, record, runDir: join(runsDir, runId) };
}

/** A CLI that answers a review with `answer`, and records every brief it got. */
function reviewer(id: string, answer: string, detection?: CliDetection): FakeCliDriver {
  return new FakeCliDriver({ id, ...(detection ? { detection } : {}), events: [{ type: 'text', text: answer }] });
}

describe('verifyPr', () => {
  it('should verify with a family that wrote none of the integration commits, keyed to head, base and patch-id', async () => {
    const { repo, record, runDir } = setup('pass', true);
    const drivers = new Map([['claude', reviewer('claude', 'VERDICT: PASS')], ['codex', reviewer('codex', 'VERDICT: PASS')], ['gemini', reviewer('gemini', 'VERDICT: PASS\nclean')]]);

    const verdict = await verifyPr({ record, runDir, drivers });

    const head = git(repo, 'rev-parse', record.synthesis!.branch!);
    const diff = execFileSync('git', ['diff', record.baseSha, head], { cwd: repo });
    const expectedPatchId = execFileSync('git', ['patch-id', '--stable'], { cwd: repo, input: diff, encoding: 'utf8' }).split(' ')[0];
    expect(verdict).toMatchObject({
      verdict: 'PASS', verifier: { provider: 'gemini', family: 'google' }, authorFamilies: ['anthropic', 'openai'],
      headSha: head, baseSha: record.baseSha, patchId: expectedPatchId, gates: { test: 'pass' }, tests: { 'openai-1': 'pass' },
      review: { status: 'PASS', text: 'VERDICT: PASS\nclean' }, reportPath: join(runDir, 'verification.md'),
    });
    expect(verdict.authorFamilies).not.toContain(verdict.verifier!.family);
    // Only the verifier ran, read-only.
    expect(drivers.get('claude')!.runs).toHaveLength(0);
    expect(drivers.get('codex')!.runs).toHaveLength(0);
    expect(drivers.get('gemini')!.runs.map((r) => [r.brief.mode, r.brief.allowedActions])).toEqual([['plan', ['read']]]);
    expect(readFileSync(verdict.reportPath!, 'utf8')).toContain(`## Verdict: PASS\n\nevery gate and valid adversarial test passes at ${head.slice(0, 12)}`);
    // Its worktrees are gone, the checkout is untouched.
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  }, 30_000);

  it('should FAIL when a valid adversarial test fails at the head', async () => {
    const { record, runDir } = setup('fail', false);
    const drivers = new Map([['gemini', reviewer('gemini', 'VERDICT: PASS')]]);

    const verdict = await verifyPr({ record, runDir, drivers });

    expect(verdict).toMatchObject({ verdict: 'FAIL', gates: { test: 'pass' }, tests: { 'openai-1': 'fail' } });
    expect(verdict.reason).toContain('adversarial test openai-1 is fail');
  }, 30_000);

  it('should be BLOCKED, with no same-family fallback, when only author families are usable', async () => {
    const { record, runDir } = setup('blocked', true);
    const gemini = reviewer('gemini', 'VERDICT: PASS', { installed: false, auth: 'unknown' });
    const drivers = new Map([['claude', reviewer('claude', 'VERDICT: PASS')], ['codex', reviewer('codex', 'VERDICT: PASS')], ['gemini', gemini]]);

    const verdict = await verifyPr({ record, runDir, drivers });

    expect(verdict).toMatchObject({
      verdict: 'BLOCKED', verifier: null, gates: {}, tests: {},
      reason: 'no installed, signed-in CLI outside the author families (anthropic, openai) can verify',
    });
    expect([...drivers.values()].flatMap((d) => d.runs)).toHaveLength(0);
  }, 30_000);
});

describe('requestPr and prStatus', () => {
  it('should push and open nothing without approval, and void the verdict after a new commit', async () => {
    const { repo, record, runDir } = setup('ship', true);
    const remote = join(sandbox, 'ship.git');
    git(sandbox, 'init', '-q', '--bare', remote);
    git(repo, 'remote', 'add', 'origin', remote);
    const verdict = await verifyPr({ record, runDir, drivers: new Map([['gemini', reviewer('gemini', 'VERDICT: PASS')]]) });

    const { pr, gates } = await requestPr({ record, runDir, verdict, remote: 'origin', base: 'main' });

    expect(gates.map((g) => [g.kind, g.status])).toEqual([['push', 'pending'], ['pr', 'pending']]);
    expect(gates[0].command).toEqual(['git', 'push', 'origin', `refs/heads/${record.synthesis!.branch}:refs/heads/concilium/ship-run`]);
    expect(gates[1].command).toEqual(['gh', 'pr', 'create', '--head', 'concilium/ship-run', '--title', 'sum rejects non-numbers', '--body-file', pr.bodyPath, '--base', 'main']);
    expect(pr).toMatchObject({ remote: 'origin', remoteBranch: 'concilium/ship-run', draft: false, pushGate: gates[0].id, prGate: gates[1].id });
    expect(readFileSync(pr.bodyPath, 'utf8')).toContain(`**Verdict: PASS** at \`${verdict.headSha}\``);
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('');

    await approveGate(runsDir, gates[0].id);
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/concilium/ship-run');
    expect((await listGates(runsDir, record.id)).map((g) => g.status)).toEqual(['executed', 'pending']);

    const shipped = { ...record, prVerdict: verdict, pr };
    const before = await prStatus(shipped, runsDir);
    expect(before.heads).toEqual({ local: verdict.headSha, remote: verdict.headSha });
    expect(before.state).toEqual({ valid: true, reason: `for head ${verdict.headSha!.slice(0, 12)}` });

    const worktree = join(sandbox, 'ship-wt');
    git(repo, 'worktree', 'add', '-q', worktree, record.synthesis!.branch!);
    writeFileSync(join(worktree, 'late.txt'), 'late\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-q', '-m', 'late commit');
    const after = await prStatus(shipped, runsDir);
    expect(after.state?.valid).toBe(false);
    expect(after.state?.reason).toContain(`void: ${record.synthesis!.branch} is at ${git(worktree, 'rev-parse', 'HEAD').slice(0, 12)}`);
  }, 30_000);

  it('should open a draft when the verdict is not a pass', async () => {
    const { record, runDir } = setup('draft', false);
    const verdict = await verifyPr({ record, runDir, drivers: new Map([['gemini', reviewer('gemini', 'VERDICT: PASS')]]) });

    const { pr, gates } = await requestPr({ record, runDir, verdict, remote: 'origin' });

    expect(pr.draft).toBe(true);
    expect(gates[1].command.slice(-1)).toEqual(['--draft']);
    expect(gates[1].command).not.toContain('--base');
  }, 30_000);
});
