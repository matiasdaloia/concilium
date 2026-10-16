/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
const coreEntry = pathToFileURL(join(cliRoot, '..', 'core', 'dist', 'index.js')).href;
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const binPath = join(cliRoot, 'bin', 'concilium.ts');

// HOME holds the only git config git reads (with a commit identity); XDG_CACHE_HOME holds the worktrees.
const sandbox = mkdtempSync(join(tmpdir(), 'concilium-gc-test-'));
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: sandbox,
  XDG_CONFIG_HOME: join(sandbox, 'config'),
  XDG_DATA_HOME: join(sandbox, 'data'),
  XDG_CACHE_HOME: join(sandbox, 'cache'),
  GIT_CONFIG_NOSYSTEM: '1',
};
writeFileSync(join(sandbox, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
const worktreeRoot = join(sandbox, 'cache', 'concilium', 'worktrees');

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trimEnd();
}

function gc(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ['--import', tsxLoader, binPath, 'gc', ...args], { cwd: sandbox, env, encoding: 'utf8' });
}

/** A process that starts a run with three candidate worktrees, says `ready`, then waits to be killed. */
function startCandidates(repo: string, runId: string) {
  const script = `
    const { GitWorktreeWorkspace, setLogLevel } = await import(${JSON.stringify(coreEntry)});
    setLogLevel('error');
    const manager = new GitWorktreeWorkspace({ root: ${JSON.stringify(worktreeRoot)} });
    await manager.startRun({ repoDir: ${JSON.stringify(repo)}, runId: ${JSON.stringify(runId)} });
    for (const candidateId of ['claude', 'codex', 'gemini']) {
      await manager.create({ repoDir: ${JSON.stringify(repo)}, runId: ${JSON.stringify(runId)}, candidateId });
    }
    console.log('ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('ready') && resolve());
    child.on('exit', (code) => reject(new Error(`candidate process exited early (${code})`)));
  });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return { child, ready, exited };
}

describe('concilium gc', () => {
  it('should collect a killed run with idempotent gc runs while the user checkout stays clean', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'branch', 'feature');
    const state = () => ({
      worktrees: git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')),
      branches: git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'),
      status: git(repo, 'status', '--porcelain'),
      cache: readdirSync(worktreeRoot, { recursive: true }).sort(),
    });

    const run = startCandidates(repo, 'run1');
    await run.ready;
    expect(state().worktrees).toHaveLength(4);
    expect(state().status).toBe('');

    // While the process lives, gc leaves its run alone.
    const whileAlive = gc();
    expect(whileAlive.status).toBe(0);
    expect(whileAlive.stdout).toContain('run1');
    expect(whileAlive.stdout).toContain('still running, skipped');
    expect(state().worktrees).toHaveLength(4);

    run.child.kill('SIGKILL');
    await run.exited;

    const dry = gc('--dry-run');
    expect(dry.stdout).toContain('would remove 3 worktrees, would delete 3 branches');
    expect(state().worktrees).toHaveLength(4);

    const first = gc();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('run1');
    expect(first.stdout).toContain('removed 3 worktrees, deleted 3 branches');
    const afterFirst = state();

    const second = gc();
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe('Nothing to collect.');
    expect(state()).toEqual(afterFirst);

    expect(afterFirst.worktrees).toHaveLength(1);
    expect(afterFirst.branches.split('\n').sort()).toEqual(['feature', 'main']);
    expect(afterFirst.status).toBe('');
    expect(afterFirst.cache).toEqual([]);
  }, 30_000);

  it('should say so when a run id has nothing recorded', () => {
    const result = gc('--run', 'unknown');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('No worktrees recorded for run unknown.');
  });

  it('should exit 1 on an invalid run id', () => {
    const result = gc('--run', '../etc');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid run id');
    expect(result.stdout).toBe('');
  });
});
