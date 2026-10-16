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

// HOME holds the only git config git reads; XDG_* keep config, run records and worktrees in the sandbox.
const sandbox = mkdtempSync(join(tmpdir(), 'concilium-code-test-'));
const binDir = join(sandbox, 'bin');
const cwdLog = join(sandbox, 'cwd.log');
const env: NodeJS.ProcessEnv = {
  // Only the fake agent CLIs and git: a real claude or codex can never start.
  PATH: binDir,
  HOME: sandbox,
  XDG_CONFIG_HOME: join(sandbox, 'config'),
  XDG_DATA_HOME: join(sandbox, 'data'),
  XDG_CACHE_HOME: join(sandbox, 'cache'),
  GIT_CONFIG_NOSYSTEM: '1',
};
const repo = join(sandbox, 'repo');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' }).trimEnd();
}

/**
 * A fake agent CLI that edits files in its cwd, as the real one would in its worktree. `claude` adds input
 * validation and a test and succeeds; `codex` writes half a change and exits 1.
 */
function fakeAgentCli(cli: 'claude' | 'codex'): string {
  return `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(cwdLog)}, ${JSON.stringify(cli)} + ' ' + process.cwd() + '\\n');
if (${JSON.stringify(cli)} === 'claude') {
  fs.writeFileSync('sum.js', 'module.exports = (a, b) => { if (typeof a !== "number") throw new TypeError("a"); return a + b; };\\n');
  fs.writeFileSync('sum.test.js', 'require("./sum")(1, 2);\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Added validation', usage: { input_tokens: 10, output_tokens: 5 } }));
} else {
  fs.writeFileSync('half.js', 'partial\\n');
  console.error('codex: something broke');
  process.exit(1);
}
`;
}

function code(...args: string[]) {
  return spawnSync(process.execPath, ['--import', tsxLoader, binPath, 'code', ...args], { cwd: repo, env, encoding: 'utf8' });
}

beforeAll(() => {
  writeFileSync(join(sandbox, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  mkdirSync(binDir);
  for (const cli of ['claude', 'codex'] as const) writeFileSync(join(binDir, cli), fakeAgentCli(cli), { mode: 0o755 });
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(binDir, 'git'));
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe('concilium code', () => {
  it('should put each candidate on its own branch, keep going past a failed one, and leave the checkout untouched', () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const result = code('--json', '--agents', 'claude,codex', 'add input validation to sum with a test');

    expect(result.status).toBe(0);
    const record = JSON.parse(result.stdout) as CodeRunRecord;
    expect(record).toMatchObject({ kind: 'code', baseSha: head, task: 'add input validation to sum with a test' });
    const [claude, codex] = record.candidates;

    expect(claude).toMatchObject({ status: 'ok', branch: `concilium/${record.id}/claude`, committed: true, usage: { inputTokens: 10, outputTokens: 5 } });
    expect(claude.diffStat).toEqual({ commits: 1, filesChanged: 2, insertions: 2, deletions: 1 });
    expect(git(repo, 'show', `${claude.branch}:sum.js`)).toContain('TypeError');
    expect(git(repo, 'rev-parse', claude.branch)).toBe(claude.headSha);

    expect(codex).toMatchObject({ status: 'error', committed: true });
    expect(codex.errors.join('\n')).toContain('codex exited with code 1');
    expect(git(repo, 'show', `${codex.branch}:half.js`)).toBe('partial');
    expect(codex.headSha).not.toBe(claude.headSha);

    // The agents ran in their worktrees, outside the repo; the checkout is unchanged.
    const cwds = readFileSync(cwdLog, 'utf8').trim().split('\n').sort();
    expect(cwds).toEqual([`claude ${claude.worktree}`, `codex ${codex.worktree}`]);
    expect(claude.worktree.startsWith(join(sandbox, 'cache', 'concilium', 'worktrees'))).toBe(true);
    expect(existsSync(join(claude.worktree, 'sum.test.js'))).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');

    // The record is saved next to the plan runs, and the finished run is gc's to collect.
    const saved = JSON.parse(readFileSync(join(sandbox, 'data', 'concilium', 'runs', record.id, 'run.json'), 'utf8')) as CodeRunRecord;
    expect(saved).toEqual(record);
    const gc = spawnSync(process.execPath, ['--import', tsxLoader, binPath, 'gc', '--run', record.id, '--dry-run'], { cwd: repo, env, encoding: 'utf8' });
    expect(gc.stdout).toContain('would remove 2 worktrees, would delete 2 branches');
  }, 30_000);

  it('should print a summary with how to inspect and clean up', () => {
    const result = code('--agents', 'claude', 'add input validation to sum');

    expect(result.status).toBe(0);
    const runId = /Run (\S+) in /.exec(result.stdout)?.[1];
    expect(runId).toBeDefined();
    expect(result.stdout).toMatch(/claude\s+ok\s+2\s+\+2\/-1\s+1\s+/);
    expect(result.stdout).toContain(`diff ${git(repo, 'rev-parse', 'HEAD').slice(0, 12)}..concilium/${runId}/claude`);
    expect(result.stdout).toContain(`concilium gc --run ${runId}`);
    expect(result.stderr).toContain('claude: ok');
  }, 30_000);

  it('should refuse a dirty checkout and exit 1 when every candidate fails', () => {
    writeFileSync(join(repo, 'sum.js'), 'dirty\n');
    const dirty = code('--json', '--agents', 'claude', 't');
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toBe('');
    expect(JSON.parse(dirty.stderr.trim().split('\n').at(-1)!).error).toContain('uncommitted changes');
    git(repo, 'checkout', '--', 'sum.js');

    const failed = code('--json', '--agents', 'codex', 't');
    expect(failed.status).toBe(1);
    expect((JSON.parse(failed.stdout) as CodeRunRecord).candidates[0].status).toBe('error');
  }, 30_000);
});
