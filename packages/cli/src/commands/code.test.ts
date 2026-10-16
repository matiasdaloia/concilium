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

const framerLog = join(sandbox, 'framer.log');
const RUBRIC = [
  { name: 'validates', description: 'sum rejects non-numbers, shown by a test.', weight: 3, evidence: 'gate' },
  { name: 'suite', description: 'The existing tests pass.', weight: 2, evidence: 'gate' },
  { name: 'small', description: 'Only sum.js and its test change.', weight: 1, evidence: 'judgment' },
];

/**
 * A fake agent CLI that edits files in its cwd, as the real one would in its worktree. `claude` adds input
 * validation and a test and succeeds; `codex` writes half a change, deletes `sum.test.js` and exits 1. Asked for the rubric (its cwd holds
 * only council-prompt.md), `claude` logs its argv and answers RUBRIC; `codex` fails as usual.
 */
function fakeAgentCli(cli: 'claude' | 'codex'): string {
  return `#!${process.execPath}
const fs = require('node:fs');
if (${JSON.stringify(cli)} === 'claude' && fs.existsSync('council-prompt.md')) {
  fs.appendFileSync(${JSON.stringify(framerLog)}, process.argv.slice(2).join(' ') + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ criteria: ${JSON.stringify(RUBRIC)} }) }));
  process.exit(0);
}
if (!fs.existsSync('council-prompt.md')) fs.appendFileSync(${JSON.stringify(cwdLog)}, ${JSON.stringify(cli)} + ' ' + process.cwd() + '\\n');
if (${JSON.stringify(cli)} === 'claude') {
  fs.writeFileSync('sum.js', 'module.exports = (a, b) => { if (typeof a !== "number") throw new TypeError("a"); return a + b; };\\n');
  fs.writeFileSync('sum.test.js', 'require("./sum")(1, 2);\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Added validation', usage: { input_tokens: 10, output_tokens: 5 } }));
} else {
  fs.writeFileSync('half.js', 'partial\\n');
  fs.rmSync('sum.test.js', { force: true });
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

    // No --type: the classifier picks one and says why. The first agent tailored the rubric read-only, before the candidates.
    expect(record.taskType).toEqual({ type: 'feature', source: 'classifier', reason: 'no keyword matched, feature is the default' });
    expect(record.rubric).toMatchObject({ criteria: RUBRIC, source: 'framer', framer: 'claude' });
    expect(readFileSync(framerLog, 'utf8')).toContain('--permission-mode=plan');
    // Candidates get the playbook, never the rubric.
    for (const c of record.candidates) {
      expect(c.brief!.task).toContain('## Playbook: feature');
      expect(c.brief!.task).not.toContain(record.rubric.sha256);
    }

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
    // Two candidates, plus the base the gates ran on.
    expect(gc.stdout).toContain('would remove 3 worktrees, would delete 3 branches');
  }, 30_000);

  it('should print a summary with how to inspect and clean up', () => {
    const result = code('--agents', 'claude', '--type', 'bugfix', 'add input validation to sum');

    expect(result.status).toBe(0);
    const runId = /Run (\S+) in /.exec(result.stdout)?.[1];
    expect(result.stdout).toContain('Type bugfix (from --type)');
    expect(result.stdout).toMatch(/Rubric 3 criteria, tailored by claude, sha256 [0-9a-f]{12}\n/);
    // The type and rubric are shown before the first candidate starts.
    expect(result.stderr.indexOf('Type bugfix')).toBeLessThan(result.stderr.indexOf('▶ claude'));
    expect(runId).toBeDefined();
    expect(result.stdout).toMatch(/claude\s+ok\s+PASS\s+2\s+\+2\/-1\s+1\s+/);
    expect(result.stdout).toContain('Gates (detected, on the base and each candidate head; only new failures count):\n    none found');
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
    const record = JSON.parse(failed.stdout) as CodeRunRecord;
    expect(record.candidates[0].status).toBe('error');
    // The codex framer failed too, so the rubric is the playbook's.
    expect(record.rubric).toMatchObject({ source: 'playbook', framer: 'codex', note: 'codex gave no answer' });
  }, 30_000);

  it('should refuse an unknown --type before touching the repo', () => {
    const result = code('--json', '--agents', 'claude', '--type', 'bug-fix', 't');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr.trim()).error).toBe('--type must be one of bugfix, feature, refactor, perf, prototype, got "bug-fix"');
  });

  it('should run the gates on the base and each candidate and show the gates table and integrity findings', () => {
    // The test gate passes on the base; the lint gate already fails there.
    writeFileSync(join(repo, 'sum.test.js'), 'require("./sum")(1, 2);\n');
    mkdirSync(join(repo, '.concilium'));
    const node = JSON.stringify(process.execPath);
    writeFileSync(join(repo, '.concilium', 'verify.yaml'), `gates:\n  test: '${node} sum.test.js'\n  lint: '${node} -e "process.exit(1)"'\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'gates');

    const result = code('--agents', 'claude,codex', 'add input validation to sum');

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('✓ base gate test: pass');
    expect(result.stderr).toContain('✗ base gate lint: fail');
    expect(result.stdout).toMatch(/claude\s+ok\s+PASS\s/);
    expect(result.stdout).toMatch(/codex\s+error\s+DISQUALIFIED\s/);
    expect(result.stdout).toContain('Gates (.concilium/verify.yaml, on the base and each candidate head; only new failures count):');
    expect(result.stdout).toMatch(/Gate\s+base\s+claude\s+codex\n/);
    expect(result.stdout).toMatch(/test\s+pass\s+pass\s+fail \(new\)\n/);
    expect(result.stdout).toMatch(/lint\s+fail\s+fail \(baseline\)\s+fail \(baseline\)\n/);
    expect(result.stdout).toContain('Integrity:\n    codex: disqualified, deleted the test file sum.test.js');

    const skipped = code('--json', '--no-verify', '--agents', 'claude', 'add input validation to sum');
    expect(skipped.status).toBe(0);
    const record = JSON.parse(skipped.stdout) as CodeRunRecord;
    expect(record.verification).toBeUndefined();
    expect(skipped.stderr).not.toContain('gate test');
    expect(git(repo, 'branch', '--list', `concilium/${record.id}/base`)).toBe('');
  }, 30_000);
});
