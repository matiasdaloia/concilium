/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const FIXED_SUM = 'module.exports = (a, b) => { if (typeof a !== "number") throw new TypeError("a"); return a + b; };\n';

/** Commits `files` on `branch` through a worktree, so the checkout stays on `main`. */
function commitOn(repo: string, branch: string, files: Record<string, string>, message: string): string {
  const worktree = mkdtempSync(join(sandbox, 'wt-'));
  git(repo, 'worktree', 'add', '-q', worktree, branch);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(worktree, path, '..'), { recursive: true });
    writeFileSync(join(worktree, path), text);
  }
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', message);
  const sha = git(worktree, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'remove', '--force', worktree);
  return sha;
}

/**
 * A repo whose integration branch is the `claude` base plus a graft from `codex`, folded in by `claude`, then (with
 * `trail`) the trail commit, and an `adv-openai` adversary branch holding a valid test. `fixed` decides whether the
 * integration passes it.
 */
function setup(name: string, opts: { fixed: boolean; trail?: boolean }): { repo: string; record: CodeRunRecord; runDir: string; graftSha: string } {
  const repo = join(sandbox, name);
  const runId = `${name}-run`;
  git(sandbox, 'init', '-q', repo);
  writeFileSync(join(repo, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'run-tests.js'), RUN_TESTS);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const baseSha = git(repo, 'rev-parse', 'HEAD');

  const branch = `concilium/${runId}/integration`;
  git(repo, 'branch', branch);
  const baseHead = commitOn(repo, branch, { 'sum.js': opts.fixed ? FIXED_SUM : 'module.exports = (a, b) => b + a;\n' }, 'claude candidate');
  const graftSha = commitOn(repo, branch, { 'notes.md': 'grafted\n' }, 'graft-1');
  const trailSha = opts.trail ? commitOn(repo, branch, { [`.concilium/runs/${runId}/decisions.tsv`]: 'ts\tevent\n' }, 'decision trail') : null;

  git(repo, 'branch', `concilium/${runId}/adv-openai`, baseSha);
  const advSha = commitOn(repo, `concilium/${runId}/adv-openai`, { 'openai-1.test.js': ADVERSARIAL_TEST }, 'adversarial test');

  const record = {
    version: 1, kind: 'code', id: runId, status: 'done', task: 'sum rejects non-numbers', repoDir: repo, headSha: baseSha, baseSha,
    dissent: { path: null, records: [] },
    candidates: [
      { candidateId: 'claude', provider: 'claude', branch: `concilium/${runId}/claude`, headSha: baseHead },
      { candidateId: 'codex', provider: 'codex', branch: `concilium/${runId}/codex`, headSha: baseHead },
    ],
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
      base: { candidateId: 'claude', headSha: baseHead, reason: 'best' }, branch, worktree: null, headSha: graftSha, picker: null, notes: [],
      grafts: [{ id: 'graft-1', candidateId: 'codex', commitSha: graftSha, status: 'applied', integrator: { provider: 'claude' } }],
      dropouts: [], checks: null, patchPath: null, synthesisPath: null, mergeable: true, mergeCheck: null,
    },
    ...(trailSha ? { trail: { decisionsPath: '', eventsPath: '', rows: 0, commitSha: trailSha, errors: [] } } : {}),
  } as unknown as CodeRunRecord;
  return { repo, record, runDir: join(runsDir, runId), graftSha };
}

/** A CLI that answers a review with `answer`, and records every brief it got. */
function reviewer(id: string, answer: string, detection?: CliDetection): FakeCliDriver {
  return new FakeCliDriver({ id, ...(detection ? { detection } : {}), events: [{ type: 'text', text: answer }] });
}

const missing = (id: string) => reviewer(id, 'VERDICT: PASS', { installed: false, auth: 'unknown' });

function withRemote(repo: string, name: string): string {
  const remote = join(sandbox, `${name}.git`);
  git(sandbox, 'init', '-q', '--bare', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  return remote;
}

describe('verifyPr', () => {
  it('should verify the head without the trail commit, from a family that wrote none of it, keyed to commit, base and patch-id', async () => {
    const { repo, record, runDir, graftSha } = setup('pass', { fixed: true, trail: true });
    const drivers = new Map([['claude', reviewer('claude', 'VERDICT: PASS')], ['codex', reviewer('codex', 'VERDICT: PASS')], ['gemini', reviewer('gemini', 'VERDICT: PASS\nclean')]]);

    const verdict = await verifyPr({ record, runDir, drivers });

    const branchHead = git(repo, 'rev-parse', record.synthesis!.branch!);
    const diff = execFileSync('git', ['diff', record.baseSha, graftSha], { cwd: repo });
    const expectedPatchId = execFileSync('git', ['patch-id', '--stable'], { cwd: repo, input: diff, encoding: 'utf8' }).split(' ')[0];
    expect(verdict).toMatchObject({
      verdict: 'PASS', verifier: { provider: 'gemini', family: 'google', sameFamily: false, configured: false }, authorFamilies: ['anthropic', 'openai'],
      branch: record.synthesis!.branch, branchHead, headSha: graftSha, trailSha: record.trail!.commitSha, baseSha: record.baseSha, patchId: expectedPatchId,
      gates: { test: 'pass' }, tests: { 'openai-1': 'pass' }, review: { status: 'PASS', text: 'VERDICT: PASS\nclean' }, reportPath: join(runDir, 'verification.md'),
    });
    expect(branchHead).toBe(record.trail!.commitSha);
    // The verified commit carries no trail file.
    expect(git(repo, 'diff', '--name-only', record.baseSha, verdict.headSha!)).toBe('notes.md\nsum.js');
    // Only the verifier ran, read-only.
    expect(drivers.get('claude')!.runs).toHaveLength(0);
    expect(drivers.get('codex')!.runs).toHaveLength(0);
    expect(drivers.get('gemini')!.runs.map((r) => [r.brief.mode, r.brief.allowedActions])).toEqual([['plan', ['read']]]);
    const report = readFileSync(verdict.reportPath!, 'utf8');
    expect(report).toContain(`## Verdict: PASS\n\nevery gate and valid adversarial test passes at ${graftSha.slice(0, 12)}`);
    expect(report).toContain(`- trail commit left out: ${record.trail!.commitSha}`);
    // Its worktrees are gone, the checkout is untouched.
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  }, 30_000);

  it('should FAIL when a valid adversarial test fails at the head', async () => {
    const { record, runDir } = setup('fail', { fixed: false });
    const drivers = new Map([['gemini', reviewer('gemini', 'VERDICT: PASS')]]);

    const verdict = await verifyPr({ record, runDir, drivers });

    expect(verdict).toMatchObject({ verdict: 'FAIL', gates: { test: 'pass' }, tests: { 'openai-1': 'fail' }, trailSha: null });
    expect(verdict.reason).toContain('adversarial test openai-1 is fail');
  }, 30_000);

  it('should prefer a configured verifier outside the author families', async () => {
    const { record, runDir } = setup('configured', { fixed: true });
    const drivers = new Map([['codex', reviewer('codex', 'VERDICT: PASS')], ['gemini', reviewer('gemini', 'VERDICT: PASS')], ['opencode', reviewer('opencode', 'VERDICT: PASS')]]);
    record.synthesis!.grafts = [];

    const verdict = await verifyPr({ record, runDir, drivers, verifier: 'gemini:gemini-3-pro' });

    expect(verdict.verifier).toEqual({ provider: 'gemini', model: 'gemini-3-pro', configured: true, sameFamily: false, family: 'google' });
    expect(drivers.get('gemini')!.runs.map((r) => r.opts.model)).toEqual(['gemini-3-pro']);
    expect(drivers.get('codex')!.runs).toHaveLength(0);
  }, 30_000);

  it('should fall back to an author family, flagged same-family, when no other family is usable', async () => {
    const { record, runDir } = setup('same-family', { fixed: true });
    const drivers = new Map([['claude', reviewer('claude', 'VERDICT: PASS')], ['codex', reviewer('codex', 'VERDICT: PASS')], ['gemini', missing('gemini')]]);

    const verdict = await verifyPr({ record, runDir, drivers });

    expect(verdict).toMatchObject({
      verdict: 'PASS', gates: { test: 'pass' }, tests: { 'openai-1': 'pass' },
      verifier: {
        provider: 'claude', family: 'anthropic', sameFamily: true,
        sameFamilyReason: 'no installed, signed-in CLI outside the author families (anthropic, openai); claude (anthropic) verified',
      },
    });
    expect(drivers.get('claude')!.runs).toHaveLength(1);
    const report = readFileSync(verdict.reportPath!, 'utf8');
    expect(report).toContain('**Warning: same-family verification: no installed, signed-in CLI outside the author families (anthropic, openai)');
    expect(report).toContain('- verifier: claude (anthropic), SAME FAMILY as the authors');
  }, 30_000);

  it('should be BLOCKED only when no agent CLI is usable at all', async () => {
    const { record, runDir } = setup('blocked', { fixed: true });
    const drivers = new Map([['claude', missing('claude')], ['codex', missing('codex')], ['gemini', missing('gemini')]]);

    const verdict = await verifyPr({ record, runDir, drivers });

    expect(verdict).toMatchObject({ verdict: 'BLOCKED', verifier: null, gates: {}, tests: {}, reason: 'no installed, signed-in agent CLI can verify' });
    expect([...drivers.values()].flatMap((d) => d.runs)).toHaveLength(0);
  }, 30_000);

  it('should be BLOCKED, with no commit to push, when the trail commit is not at the head', async () => {
    const { repo, record, runDir } = setup('buried-trail', { fixed: true, trail: true });
    commitOn(repo, record.synthesis!.branch!, { 'late.txt': 'late\n' }, 'late commit');

    const verdict = await verifyPr({ record, runDir, drivers: new Map([['gemini', reviewer('gemini', 'VERDICT: PASS')]]) });

    expect(verdict).toMatchObject({ verdict: 'BLOCKED', headSha: null, trailSha: null });
    expect(verdict.reason).toContain(`would ship decision-trail files (.concilium/runs/buried-trail-run/decisions.tsv)`);
    await expect(requestPr({ record, runDir, verdict, remote: 'origin' })).rejects.toThrow('has no verified commit to push');
  }, 30_000);
});

describe('requestPr and prStatus', () => {
  it('should push exactly the verified commit, without the trail, after approval, and void the verdict after a new commit', async () => {
    const { repo, record, runDir, graftSha } = setup('ship', { fixed: true, trail: true });
    const remote = withRemote(repo, 'ship');
    const verdict = await verifyPr({ record, runDir, drivers: new Map([['gemini', reviewer('gemini', 'VERDICT: PASS')]]) });

    const { pr, gates, reused } = await requestPr({ record, runDir, verdict, remote: 'origin', base: 'main' });

    expect(reused).toBe(false);
    expect(gates.map((g) => [g.kind, g.status])).toEqual([['push', 'pending'], ['pr', 'pending']]);
    expect(gates[0].command).toEqual(['git', 'push', 'origin', `${graftSha}:refs/heads/concilium/ship-run`]);
    expect(gates[1].command).toEqual(['gh', 'pr', 'create', '--head', 'concilium/ship-run', '--title', 'sum rejects non-numbers', '--body-file', pr.bodyPath, '--base', 'main']);
    expect(pr).toMatchObject({ remote: 'origin', remoteBranch: 'concilium/ship-run', sha: graftSha, draftReason: null, pushGate: gates[0].id, prGate: gates[1].id });
    const body = readFileSync(pr.bodyPath, 'utf8');
    expect(body).toContain(`**Verdict: PASS** at \`${graftSha}\``);
    expect(body).toContain(`are in commit \`${record.trail!.commitSha}\` on \`${record.synthesis!.branch}\`, left out of this pull request`);
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('');

    // The branch moves before the approval: the push still sends the verified commit.
    const late = commitOn(repo, record.synthesis!.branch!, { 'late.txt': 'late\n' }, 'late commit');
    await approveGate(runsDir, gates[0].id);
    expect(git(remote, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(`refs/heads/concilium/ship-run ${graftSha}`);
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'concilium/ship-run')).not.toContain('.concilium');
    expect((await listGates(runsDir, record.id)).map((g) => g.status)).toEqual(['executed', 'pending']);

    git(repo, 'fetch', '-q', 'origin');
    const status = await prStatus({ ...record, prVerdict: verdict, pr }, runsDir);
    expect(status.heads).toEqual({ local: late, remote: graftSha });
    expect(status.state).toEqual({
      valid: false,
      reason: `void: ${record.synthesis!.branch} is at ${late.slice(0, 12)}, the verdict is for ${record.trail!.commitSha!.slice(0, 12)}; run verify-pr again`,
    });
  }, 30_000);

  it('should hold the verdict while the branch stays at the verified head', async () => {
    const { repo, record, runDir, graftSha } = setup('hold', { fixed: true, trail: true });
    withRemote(repo, 'hold');
    const verdict = await verifyPr({ record, runDir, drivers: new Map([['gemini', reviewer('gemini', 'VERDICT: PASS')]]) });
    const { pr, gates } = await requestPr({ record, runDir, verdict, remote: 'origin' });
    await approveGate(runsDir, gates[0].id);
    git(repo, 'fetch', '-q', 'origin');

    const status = await prStatus({ ...record, prVerdict: verdict, pr }, runsDir);

    expect(status.heads).toEqual({ local: record.trail!.commitSha, remote: graftSha });
    expect(status.state).toEqual({ valid: true, reason: `for commit ${graftSha.slice(0, 12)}` });
  }, 30_000);

  it('should reuse the gates for the same commit and supersede the pending ones once the commit changes', async () => {
    const { repo, record, runDir } = setup('again', { fixed: true });
    const drivers = new Map([['gemini', reviewer('gemini', 'VERDICT: PASS')]]);
    const first = await requestPr({ record, runDir, verdict: await verifyPr({ record, runDir, drivers }), remote: 'origin' });

    const same = await requestPr({ record, runDir, verdict: await verifyPr({ record, runDir, drivers }), remote: 'origin' });
    expect(same).toMatchObject({ reused: true, superseded: [] });
    expect(same.gates.map((g) => g.id)).toEqual(first.gates.map((g) => g.id));
    expect(await listGates(runsDir, record.id)).toHaveLength(2);

    const late = commitOn(repo, record.synthesis!.branch!, { 'late.txt': 'late\n' }, 'late commit');
    const moved = await requestPr({ record, runDir, verdict: await verifyPr({ record, runDir, drivers }), remote: 'origin' });
    expect(moved.reused).toBe(false);
    expect(moved.superseded.map((g) => g.id)).toEqual(first.gates.map((g) => g.id));
    expect(moved.gates[0].command.at(-1)).toBe(`${late}:refs/heads/concilium/again-run`);
    expect((await listGates(runsDir, record.id)).map((g) => [g.id, g.status])).toEqual([
      ['again-run-g1', 'superseded'],
      ['again-run-g2', 'superseded'],
      ['again-run-g3', 'pending'],
      ['again-run-g4', 'pending'],
    ]);
    await expect(approveGate(runsDir, 'again-run-g1')).rejects.toThrow('superseded');
  }, 60_000);

  it('should open a draft when the verdict is not a pass', async () => {
    const { record, runDir } = setup('draft', { fixed: false });
    const verdict = await verifyPr({ record, runDir, drivers: new Map([['gemini', reviewer('gemini', 'VERDICT: PASS')]]) });

    const { pr, gates } = await requestPr({ record, runDir, verdict, remote: 'origin' });

    expect(pr.draftReason).toBe('the verdict is FAIL');
    expect(gates[1].command.slice(-1)).toEqual(['--draft']);
    expect(gates[1].command).not.toContain('--base');
  }, 30_000);

  it('should open a draft, flagged in the body, when the verifier is of an author family, even on a PASS', async () => {
    const { record, runDir } = setup('same-family-draft', { fixed: true });
    const verdict = await verifyPr({ record, runDir, drivers: new Map([['claude', reviewer('claude', 'VERDICT: PASS')], ['gemini', missing('gemini')]]) });
    expect(verdict.verdict).toBe('PASS');

    const { pr, gates } = await requestPr({ record, runDir, verdict, remote: 'origin', base: 'main' });

    expect(pr.draftReason).toBe('the verifier is of an author family');
    expect(gates[1].command.slice(-1)).toEqual(['--draft']);
    expect(readFileSync(pr.bodyPath, 'utf8')).toContain('> **Warning: same-family verification:');
  }, 30_000);

  it("should ship a single-candidate run from the candidate's branch, written by its family alone", async () => {
    const repo = join(sandbox, 'single');
    git(sandbox, 'init', '-q', repo);
    writeFileSync(join(repo, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
    writeFileSync(join(repo, 'run-tests.js'), RUN_TESTS);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    const branch = 'concilium/single-run/codex';
    git(repo, 'branch', branch);
    const head = commitOn(repo, branch, { 'sum.js': FIXED_SUM }, 'codex candidate');
    const remote = withRemote(repo, 'single');
    const record = {
      version: 1, kind: 'code', id: 'single-run', status: 'done', task: 'sum rejects non-numbers', repoDir: repo, headSha: baseSha, baseSha,
      dissent: { path: null, records: [] },
      candidates: [{ candidateId: 'codex', provider: 'codex', branch, headSha: head }],
      verification: {
        plan: { source: 'detected', gates: [{ name: 'test', command: 'node run-tests.js', timeoutMs: 60_000 }], install: null, notes: [] },
        baseline: { lane: 'base', sha: baseSha, install: null, gates: [{ name: 'test', outcome: 'pass' }] },
        errors: [],
      },
      synthesis: {
        base: null, branch: null, worktree: null, headSha: null, picker: null, notes: [], grafts: [], dropouts: [], checks: null,
        patchPath: null, synthesisPath: null, mergeable: false, mergeCheck: null, skipped: 'fewer than 2 candidates',
      },
    } as unknown as CodeRunRecord;
    const runDir = join(runsDir, 'single-run');
    const drivers = new Map([['claude', reviewer('claude', 'VERDICT: PASS')], ['codex', reviewer('codex', 'VERDICT: PASS')]]);

    const verdict = await verifyPr({ record, runDir, drivers });

    expect(verdict).toMatchObject({
      verdict: 'PASS', branch, branchHead: head, headSha: head, authorFamilies: ['openai'], verifier: { provider: 'claude', family: 'anthropic', sameFamily: false },
    });
    expect(drivers.get('codex')!.runs).toHaveLength(0);
    const { gates } = await requestPr({ record, runDir, verdict, remote: 'origin' });
    await approveGate(runsDir, gates[0].id);
    expect(git(remote, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(`refs/heads/concilium/single-run ${head}`);
  }, 30_000);
});
