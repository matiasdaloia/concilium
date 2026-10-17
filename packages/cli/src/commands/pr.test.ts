/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeRunRecord } from '@concilium/core';

const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const binPath = join(cliRoot, 'bin', 'concilium.ts');

const sandbox = mkdtempSync(join(tmpdir(), 'concilium-pr-test-'));
const binDir = join(sandbox, 'bin');
const reviewLog = join(sandbox, 'review.log');
const ghLog = join(sandbox, 'gh.log');
const env: NodeJS.ProcessEnv = {
  // Only the fake agent CLIs, the fake gh, git and node: no real CLI can start.
  PATH: binDir,
  HOME: sandbox,
  XDG_CONFIG_HOME: join(sandbox, 'config'),
  XDG_DATA_HOME: join(sandbox, 'data'),
  XDG_CACHE_HOME: join(sandbox, 'cache'),
  GIT_CONFIG_NOSYSTEM: '1',
};
const runsDir = join(sandbox, 'data', 'concilium', 'runs');
const repo = join(sandbox, 'repo');
const remote = join(sandbox, 'remote.git');

/** Installed and signed in. Asked to review, it logs its name and passes. */
function fakeAgentCli(cli: 'claude' | 'codex'): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (args === '--version') { console.log('1.0.0'); process.exit(0); }
if (args === 'auth status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0); }
if (args === 'login status') { console.log('Logged in using ChatGPT'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(reviewLog)}, ${JSON.stringify(cli)} + ' ' + fs.readFileSync('council-prompt.md', 'utf8').split('\\n')[0] + '\\n');
const text = 'VERDICT: PASS\\nLooks right.';
if (${JSON.stringify(cli)} === 'claude') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }));
else {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}
`;
}

/** Records its argv and cwd, as if it opened a PR. */
const FAKE_GH = `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
console.log('https://example.com/pull/1');
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' }).trimEnd();
}

function concilium(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ['--import', tsxLoader, binPath, ...args], { cwd: sandbox, env, encoding: 'utf8' });
}

/**
 * A run record whose integration branch is the `claude` candidate and a second commit: with `codexGraft`, a graft
 * from `codex` folded in by `claude`, else the trail commit. Its `test` gate passes. Written where `concilium` reads code runs.
 */
function writeRun(runId: string, codexGraft: boolean): CodeRunRecord {
  const baseSha = git(repo, 'rev-parse', 'main');
  const branch = `concilium/${runId}/integration`;
  const worktree = join(sandbox, `${runId}-wt`);
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, baseSha);
  writeFileSync(join(worktree, 'sum.js'), 'module.exports = (a, b) => Number(a) + Number(b);\n');
  git(worktree, 'commit', '-q', '-am', 'claude candidate');
  writeFileSync(join(worktree, 'second.txt'), 'second\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', codexGraft ? 'graft-1' : 'decision trail');
  const secondSha = git(worktree, 'rev-parse', 'HEAD');
  const synthesisPath = join(runsDir, runId, 'synthesis.md');
  mkdirSync(join(runsDir, runId), { recursive: true });
  writeFileSync(synthesisPath, `# Synthesis of run ${runId}\n\nBase: claude\n`);
  const record = {
    version: 1, kind: 'code', id: runId, status: 'done', task: 'make sum accept numeric strings', repoDir: repo, headSha: baseSha, baseSha,
    dissent: { path: null, records: [] },
    candidates: [{ candidateId: 'claude', provider: 'claude' }, { candidateId: 'codex', provider: 'codex' }],
    verification: {
      plan: { source: 'detected', gates: [{ name: 'test', command: 'node test.js', timeoutMs: 60_000 }], install: null, notes: [] },
      baseline: { lane: 'base', sha: baseSha, install: null, gates: [{ name: 'test', outcome: 'pass' }] },
      errors: [],
    },
    synthesis: {
      base: { candidateId: 'claude', headSha: baseSha, reason: 'best' }, branch, worktree, headSha: secondSha, picker: null, notes: [],
      grafts: codexGraft ? [{ id: 'graft-1', candidateId: 'codex', commitSha: secondSha, status: 'applied', integrator: { provider: 'claude' } }] : [],
      dropouts: [], checks: null, patchPath: null, synthesisPath, mergeable: true, mergeCheck: null,
    },
    trail: { decisionsPath: '', eventsPath: '', rows: 0, commitSha: secondSha, errors: [] },
  } as unknown as CodeRunRecord;
  writeFileSync(join(runsDir, runId, 'run.json'), JSON.stringify(record, null, 2));
  return record;
}

const loadRun = (runId: string) => JSON.parse(readFileSync(join(runsDir, runId, 'run.json'), 'utf8')) as CodeRunRecord;
const remoteBranches = () => git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/');

beforeAll(() => {
  writeFileSync(join(sandbox, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  mkdirSync(binDir);
  for (const cli of ['claude', 'codex'] as const) writeFileSync(join(binDir, cli), fakeAgentCli(cli), { mode: 0o755 });
  writeFileSync(join(binDir, 'gh'), FAKE_GH, { mode: 0o755 });
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(binDir, 'git'));
  symlinkSync(process.execPath, join(binDir, 'node'));
  git(sandbox, 'init', '-q', '--bare', remote);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'test.js'), "if (require('./sum.js')(1, 2) !== 3) throw new Error('1 + 2');\n");
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe('concilium pr, verify-pr and status', () => {
  it('should verify from another family, push and open nothing without approval, and void the verdict after a new commit', () => {
    const runId = '20261017T100000-aaaaaa';
    const record = writeRun(runId, false);

    const pr = concilium('pr', runId, '--base', 'main');
    expect(pr.status).toBe(0);
    const verdict = loadRun(runId).prVerdict!;
    const head = git(repo, 'rev-parse', record.synthesis!.branch!);
    expect(verdict).toMatchObject({ verdict: 'PASS', verifier: { provider: 'codex', family: 'openai' }, authorFamilies: ['anthropic'], headSha: head, baseSha: record.baseSha });
    expect(verdict.authorFamilies).not.toContain(verdict.verifier!.family);
    expect(readFileSync(reviewLog, 'utf8')).toBe('codex You are reviewing a change before it becomes a pull request. You did not write it.\n');
    expect(pr.stdout).toContain(`Verdict: PASS at ${head.slice(0, 12)} (base ${record.baseSha.slice(0, 12)}, patch-id ${verdict.patchId!.slice(0, 12)}) by codex (openai)`);
    expect(pr.stdout).toContain(`Approve in order:\n  concilium approve ${runId}-g1\n  concilium approve ${runId}-g2\n`);
    expect(existsSync(join(runsDir, runId, 'verification.md'))).toBe(true);
    // Nothing left the machine.
    expect(remoteBranches()).toBe('');
    expect(existsSync(ghLog)).toBe(false);

    const pending = concilium('status', runId);
    expect(pending.status).toBe(0);
    expect(pending.stdout).toContain(`Verdict: PASS at ${head.slice(0, 12)}`);
    expect(pending.stdout).toContain('\n  valid\n');
    expect(pending.stdout).toContain(`  ${runId}-g1  pending  push  git push origin refs/heads/${record.synthesis!.branch}:refs/heads/concilium/${runId}`);

    expect(concilium('approve', `${runId}-g1`).status).toBe(0);
    expect(remoteBranches()).toBe(`refs/heads/concilium/${runId}`);
    expect(existsSync(ghLog)).toBe(false);
    expect(concilium('approve', `${runId}-g2`).status).toBe(0);
    const bodyPath = join(runsDir, runId, 'pr-body.md');
    expect(JSON.parse(readFileSync(ghLog, 'utf8'))).toEqual({
      args: ['pr', 'create', '--head', `concilium/${runId}`, '--title', 'make sum accept numeric strings', '--body-file', bodyPath, '--base', 'main'],
      cwd: repo,
    });
    const body = readFileSync(bodyPath, 'utf8');
    expect(body).toContain(`**Verdict: PASS** at \`${head}\``);
    expect(body).toContain(`# Synthesis of run ${runId}`);
    expect(body).toContain(`in commit \`${record.trail!.commitSha}\``);

    const pushed = concilium('status', runId);
    expect(pushed.stdout).toContain(`Pushed branch: origin/concilium/${runId} at ${head.slice(0, 12)}`);
    expect(pushed.stdout).toContain('\n  valid\n');

    writeFileSync(join(record.synthesis!.worktree!, 'late.txt'), 'late\n');
    git(record.synthesis!.worktree!, 'add', '.');
    git(record.synthesis!.worktree!, 'commit', '-q', '-m', 'late commit');
    const late = git(repo, 'rev-parse', record.synthesis!.branch!);
    const stale = concilium('status', runId);
    expect(stale.stdout).toContain(`void: ${record.synthesis!.branch} is at ${late.slice(0, 12)}, the verdict is for ${head.slice(0, 12)}; run verify-pr again`);

    const again = concilium('verify-pr', runId);
    expect(again.status).toBe(0);
    expect(loadRun(runId).prVerdict!.headSha).toBe(late);
    // The pushed branch is still at the old head, so the new verdict does not hold for it either.
    expect(concilium('status', runId).stdout).toContain(`void: the pushed branch is at ${head.slice(0, 12)}`);
  }, 120_000);

  it('should be BLOCKED and exit 1 when every usable CLI is of an author family', () => {
    const runId = '20261017T110000-bbbbbb';
    writeRun(runId, true);

    const result = concilium('verify-pr', runId);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Verdict: BLOCKED');
    expect(result.stdout).toContain('no installed, signed-in CLI outside the author families (anthropic, openai) can verify');
    expect(loadRun(runId).prVerdict).toMatchObject({ verdict: 'BLOCKED', verifier: null });
  }, 60_000);

  it('should refuse an unknown or invalid run id', () => {
    expect(concilium('status', 'no-such-run')).toMatchObject({ status: 1, stderr: expect.stringContaining('no code run no-such-run') });
    expect(concilium('pr', '../x').status).toBe(1);
  }, 30_000);
});
