/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionGate, gitPushCommand, setLogLevel, type GateEntry } from '@concilium/core';

const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const binPath = join(cliRoot, 'bin', 'concilium.ts');

const sandbox = mkdtempSync(join(tmpdir(), 'concilium-gates-test-'));
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: sandbox,
  XDG_CONFIG_HOME: join(sandbox, 'config'),
  XDG_DATA_HOME: join(sandbox, 'data'),
  XDG_CACHE_HOME: join(sandbox, 'cache'),
  GIT_CONFIG_NOSYSTEM: '1',
};
writeFileSync(join(sandbox, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
const runsDir = join(sandbox, 'data', 'concilium', 'runs');
const runId = '20261017T100000-abc123';

beforeAll(() => setLogLevel('error'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trimEnd();
}

function concilium(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ['--import', tsxLoader, binPath, ...args], { cwd: sandbox, env, encoding: 'utf8' });
}

describe('concilium gates, approve and reject', () => {
  it('should push to a fake remote only after concilium approve, once', async () => {
    const repo = join(sandbox, 'repo');
    const remote = join(sandbox, 'remote.git');
    mkdirSync(repo);
    git(sandbox, 'init', '-q', '--bare', remote);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const branch = `concilium/${runId}/integration`;
    git(repo, 'branch', branch);
    git(repo, 'remote', 'add', 'origin', remote);
    const remoteBranches = () => git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/');

    const gate = new ActionGate({ runId, runDir: join(runsDir, runId) });
    await gate.request({ kind: 'push', command: gitPushCommand('origin', branch), cwd: repo });
    await gate.request({ kind: 'push', command: gitPushCommand('origin', `${branch}:refs/heads/other`), cwd: repo });

    const listed = concilium('gates');
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain(`${runId}-g1  pending  push  pushes to a remote\n    in ${repo}: git push origin ${branch}`);
    expect(remoteBranches()).toBe('');

    const approved = concilium('approve', `${runId}-g1`);
    expect(approved.status).toBe(0);
    expect(approved.stdout).toContain(`Approved ${runId}-g1: git push origin ${branch} (in ${repo})\nExecuted with exit 0`);
    expect(remoteBranches()).toBe(`refs/heads/${branch}`);

    const again = concilium('approve', `${runId}-g1`);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(`gate ${runId}-g1 is executed; each gate is decided once`);

    const rejected = concilium('reject', `${runId}-g2`);
    expect(rejected.status).toBe(0);
    expect(concilium('approve', `${runId}-g2`).status).toBe(1);
    expect(remoteBranches()).toBe(`refs/heads/${branch}`);

    const json = concilium('gates', '--run', runId, '--json');
    expect((JSON.parse(json.stdout) as GateEntry[]).map((g) => [g.id, g.status])).toEqual([
      [`${runId}-g1`, 'executed'],
      [`${runId}-g2`, 'rejected'],
    ]);
    expect(readFileSync(join(runsDir, runId, 'gates.md'), 'utf8')).toContain(`## ${runId}-g2: rejected`);
  }, 60_000);

  it('should say when there are no gates and refuse an unknown gate or run id', () => {
    expect(concilium('gates', '--run', 'no-such-run').stdout).toBe('No gates.\n');
    expect(concilium('approve', 'no-such-g1')).toMatchObject({ status: 1, stderr: expect.stringContaining('no gate no-such-g1') });
    expect(concilium('gates', '--run', '../x').status).toBe(1);
  }, 30_000);
});
