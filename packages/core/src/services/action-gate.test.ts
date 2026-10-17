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
import { setLogLevel } from '../shared/logger.js';
import {
  ActionGate,
  approveGate,
  classifyAction,
  GATES_JSON,
  GATES_MD,
  gitPushCommand,
  listGates,
  rejectGate,
  shellLine,
  type GatesFile,
} from './action-gate.js';

const sandbox = mkdtempSync(join(tmpdir(), 'concilium-action-gate-'));
writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
const runsDir = join(sandbox, 'runs');
const now = () => new Date('2026-10-17T10:00:00Z');

// Gate commands run in the process env, so point git at the sandbox config for this file.
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

/** A repo with one commit on `concilium/<run>/integration` and an empty bare remote `origin`. */
function repoWithRemote(name: string): { repo: string; remote: string; branch: string } {
  const repo = join(sandbox, name);
  const remote = join(sandbox, `${name}.git`);
  git(sandbox, 'init', '-q', '--bare', remote);
  git(sandbox, 'init', '-q', repo);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const branch = `concilium/${name}/integration`;
  git(repo, 'branch', branch);
  git(repo, 'remote', 'add', 'origin', remote);
  return { repo, remote, branch };
}

const remoteBranches = (remote: string) => git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/');

describe('classifyAction', () => {
  it('should put every B10 action in its tier', () => {
    const tier = (kind: Parameters<typeof classifyAction>[0]['kind'], ref?: string) => classifyAction({ kind, ref }).tier;

    for (const kind of ['worktree', 'run-cli', 'gate', 'store-write', 'revert', 'gc'] as const) expect(tier(kind)).toBe('proceed');
    for (const kind of ['install', 'rebase'] as const) expect(tier(kind)).toBe('proceed-and-announce');
    for (const kind of ['push', 'pr', 'write-checkout', 'deploy', 'message'] as const) expect(tier(kind)).toBe('always-pause');
    expect(tier('branch', 'concilium/r1/integration')).toBe('proceed');
    expect(tier('delete', 'refs/heads/concilium/r1/claude')).toBe('proceed');
    expect(tier('delete', 'refs/concilium/r1/snapshot')).toBe('proceed');
    expect(tier('branch', 'main')).toBe('always-pause');
    expect(tier('delete', 'feature/concilium/x')).toBe('always-pause');
    expect(tier('delete', 'concilium/../main')).toBe('always-pause');
    expect(tier('delete')).toBe('always-pause');
    expect(classifyAction({ kind: 'branch', ref: 'main' }).reason).toBe('writes main, outside concilium/');
  });

  it('should quote a command only where the shell needs it', () => {
    expect(shellLine(['git', 'push', 'origin', 'concilium/r/integration:refs/heads/x'])).toBe('git push origin concilium/r/integration:refs/heads/x');
    expect(shellLine(['gh', 'pr', 'create', '--title', "it's done"])).toBe(`gh pr create --title 'it'\\''s done'`);
  });
});

describe('ActionGate', () => {
  it('should never push without an approval, and push after concilium approve', async () => {
    const { repo, remote, branch } = repoWithRemote('push-run');
    const runDir = join(runsDir, 'push-run');
    const gate = new ActionGate({ runId: 'push-run', runDir, now });

    const outcome = await gate.request({ kind: 'push', command: gitPushCommand('origin', branch), cwd: repo, reason: 'ship the integration branch' });

    expect(outcome.tier).toBe('always-pause');
    expect(remoteBranches(remote)).toBe('');
    const file = JSON.parse(readFileSync(join(runDir, GATES_JSON), 'utf8')) as GatesFile;
    expect(file.gates).toEqual([
      {
        id: 'push-run-g1',
        runId: 'push-run',
        kind: 'push',
        command: ['git', 'push', 'origin', branch],
        cwd: repo,
        reason: 'ship the integration branch (pushes to a remote)',
        key: null,
        requestedAt: '2026-10-17T10:00:00.000Z',
        status: 'pending',
        decidedAt: null,
        executedAt: null,
        exitCode: null,
        output: null,
      },
    ]);
    const md = readFileSync(join(runDir, GATES_MD), 'utf8');
    expect(md).toContain('## push-run-g1: pending');
    expect(md).toContain(`\`\`\`sh\ngit push origin ${branch}\n\`\`\``);
    expect(md).toContain('Approve: `concilium approve push-run-g1`');

    const approved = await approveGate(runsDir, 'push-run-g1', now);

    expect(approved).toMatchObject({ status: 'executed', exitCode: 0, decidedAt: '2026-10-17T10:00:00.000Z' });
    expect(remoteBranches(remote)).toBe(`refs/heads/${branch}`);
    await expect(approveGate(runsDir, 'push-run-g1')).rejects.toThrow('gate push-run-g1 is executed; each gate is decided once');
    expect(readFileSync(join(runDir, GATES_MD), 'utf8')).toContain('## push-run-g1: executed');
  });

  it('should not let one approval cover a second gate for the same command', async () => {
    const { repo, remote, branch } = repoWithRemote('twice-run');
    const runDir = join(runsDir, 'twice-run');
    const gate = new ActionGate({ runId: 'twice-run', runDir, now });

    await gate.request({ kind: 'push', command: gitPushCommand('origin', branch), cwd: repo });
    await approveGate(runsDir, 'twice-run-g1', now);
    git(remote, 'update-ref', '-d', `refs/heads/${branch}`);
    const second = await gate.request({ kind: 'push', command: gitPushCommand('origin', branch), cwd: repo });

    expect(second.tier === 'always-pause' && second.gate.id).toBe('twice-run-g2');
    expect(remoteBranches(remote)).toBe('');
    expect((await listGates(runsDir, 'twice-run')).map((g) => [g.id, g.status])).toEqual([
      ['twice-run-g1', 'executed'],
      ['twice-run-g2', 'pending'],
    ]);
  });

  it('should reuse a keyed gate asked for again, and supersede pending keyed gates of its kind for another key', async () => {
    const { repo, remote, branch } = repoWithRemote('keyed-run');
    const gate = new ActionGate({ runId: 'keyed-run', runDir: join(runsDir, 'keyed-run'), now });
    const push = (sha: string) => gate.request({ kind: 'push', command: gitPushCommand('origin', `${sha}:refs/heads/${branch}`), cwd: repo, key: sha });
    const first = git(repo, 'rev-parse', branch);

    const asked = await push(first);
    const again = await push(first);
    expect(asked.tier === 'always-pause' && [asked.gate.id, asked.reused]).toEqual(['keyed-run-g1', false]);
    expect(again.tier === 'always-pause' && [again.gate.id, again.reused, again.superseded]).toEqual(['keyed-run-g1', true, []]);
    // A gate without a key is never reused or superseded.
    await gate.request({ kind: 'push', command: gitPushCommand('origin', branch), cwd: repo });

    git(repo, 'commit', '-q', '--allow-empty', '-m', 'second');
    const second = git(repo, 'rev-parse', 'HEAD');
    const moved = await push(second);
    expect(moved.tier === 'always-pause' && [moved.gate.id, moved.reused, moved.superseded.map((g) => g.id)]).toEqual(['keyed-run-g3', false, ['keyed-run-g1']]);
    expect((await listGates(runsDir, 'keyed-run')).map((g) => [g.id, g.status])).toEqual([
      ['keyed-run-g1', 'superseded'],
      ['keyed-run-g2', 'pending'],
      ['keyed-run-g3', 'pending'],
    ]);
    await expect(approveGate(runsDir, 'keyed-run-g1')).rejects.toThrow('gate keyed-run-g1 is superseded by a newer request');
    expect(remoteBranches(remote)).toBe('');

    // An executed keyed gate is reused too: the same commit is not asked for twice.
    await approveGate(runsDir, 'keyed-run-g3', now);
    const done = await push(second);
    expect(done.tier === 'always-pause' && [done.gate.id, done.gate.status, done.reused]).toEqual(['keyed-run-g3', 'executed', true]);
  });

  it('should never run a rejected gate', async () => {
    const { repo, remote, branch } = repoWithRemote('reject-run');
    const gate = new ActionGate({ runId: 'reject-run', runDir: join(runsDir, 'reject-run'), now });
    await gate.request({ kind: 'push', command: gitPushCommand('origin', branch), cwd: repo });

    expect(await rejectGate(runsDir, 'reject-run-g1', now)).toMatchObject({ status: 'rejected', decidedAt: '2026-10-17T10:00:00.000Z', executedAt: null });
    await expect(approveGate(runsDir, 'reject-run-g1')).rejects.toThrow('gate reject-run-g1 is rejected');
    expect(remoteBranches(remote)).toBe('');
  });

  it('should record a failed command with its exit code and output', async () => {
    const { repo } = repoWithRemote('fail-run');
    const gate = new ActionGate({ runId: 'fail-run', runDir: join(runsDir, 'fail-run'), now });
    await gate.request({ kind: 'push', command: gitPushCommand('nowhere', 'main'), cwd: repo });

    const failed = await approveGate(runsDir, 'fail-run-g1', now);

    expect(failed.status).toBe('failed');
    expect(failed.exitCode).not.toBe(0);
    expect(failed.output).toContain('nowhere');
  });

  it('should run proceed actions at once and announce the announced ones', async () => {
    const { repo } = repoWithRemote('proceed-run');
    const notices: string[] = [];
    const gate = new ActionGate({ runId: 'proceed-run', runDir: join(runsDir, 'proceed-run'), onAnnounce: (n) => notices.push(n) });

    const branch = await gate.request({ kind: 'branch', ref: 'concilium/proceed-run/extra', command: ['git', 'branch', 'concilium/proceed-run/extra'], cwd: repo });
    const install = await gate.request({ kind: 'install', command: ['git', 'status', '--short'], cwd: repo });
    const outside = await gate.request({ kind: 'branch', ref: 'main-copy', command: ['git', 'branch', 'main-copy'], cwd: repo });

    expect(branch).toMatchObject({ tier: 'proceed', result: { exitCode: 0 } });
    expect(install).toMatchObject({ tier: 'proceed-and-announce', result: { exitCode: 0 } });
    expect(notices).toEqual([`install: git status --short (in ${repo})`]);
    expect(outside.tier).toBe('always-pause');
    expect(git(repo, 'branch', '--list', 'main-copy', 'concilium/proceed-run/extra')).toBe('  concilium/proceed-run/extra');
  });

  it('should list no gates when there is no run store and refuse an unknown gate', async () => {
    expect(await listGates(join(sandbox, 'missing'))).toEqual([]);
    await expect(approveGate(runsDir, 'no-such-g1')).rejects.toThrow('no gate no-such-g1');
  });
});
