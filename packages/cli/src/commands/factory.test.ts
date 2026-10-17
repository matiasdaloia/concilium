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
import type { CodeRunRecord, FactoryRecord } from '@concilium/core';

const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const binPath = join(cliRoot, 'bin', 'concilium.ts');

const sandbox = mkdtempSync(join(tmpdir(), 'concilium-factory-test-'));
const binDir = join(sandbox, 'bin');
const reviewLog = join(sandbox, 'review.log');
const env: NodeJS.ProcessEnv = {
  // Only the fake agent CLIs and git: a real claude or codex can never start.
  PATH: binDir,
  HOME: sandbox,
  XDG_CONFIG_HOME: join(sandbox, 'config'),
  XDG_DATA_HOME: join(sandbox, 'data'),
  XDG_CACHE_HOME: join(sandbox, 'cache'),
  GIT_CONFIG_NOSYSTEM: '1',
};
const runsDir = join(sandbox, 'data', 'concilium', 'runs');
const repo = join(sandbox, 'repo');

/** Listed out of order: `square` depends on `mul`, so `mul` runs first. */
const TASKS = [
  { id: 'square', title: 'Add square.js built on mul.js', type: 'feature', acceptance: ['square(4) is 16'], depends_on: ['mul'] },
  { id: 'mul', title: 'Add mul.js exporting a multiply function', type: 'feature', acceptance: ['mul(2, 3) is 6'], depends_on: [] },
];

/**
 * A fake agent CLI, installed and signed in. Asked to plan (`You are planning`), `claude` answers TASKS; asked to
 * review, each logs its name and passes; asked for grafts, it names none; any other read-only prompt (the rubric)
 * fails, so the playbook rubric is used. As a candidate it writes `mul.js` and its test, or, where `mul.js` already
 * exists (a base stacked on the first task), `square.js` and a test that needs `mul.js`. Codex writes a bigger diff,
 * so claude wins each task on the smallest diff and codex, another family, verifies.
 */
function fakeAgentCli(cli: 'claude' | 'codex'): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (args === '--version') { console.log('1.0.0'); process.exit(0); }
if (args === 'auth status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0); }
if (args === 'login status') { console.log('Logged in using ChatGPT'); process.exit(0); }
const claude = ${JSON.stringify(cli)} === 'claude';
function say(text) {
  if (claude) console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }));
  else {
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
  }
  process.exit(0);
}
if (fs.existsSync('council-prompt.md')) {
  const prompt = fs.readFileSync('council-prompt.md', 'utf8');
  if (claude && prompt.startsWith('You are planning')) say(JSON.stringify({ tasks: ${JSON.stringify(TASKS)} }));
  if (prompt.startsWith('You are reviewing a change')) {
    fs.appendFileSync(${JSON.stringify(reviewLog)}, ${JSON.stringify(cli)} + '\\n');
    say('VERDICT: PASS\\nLooks right.');
  }
  if (prompt.startsWith('You are choosing grafts')) say('{"grafts": []}');
  process.exit(1);
}
const pad = claude ? '' : '// a longer change\\n// by codex\\n';
if (fs.existsSync('mul.js')) {
  fs.writeFileSync('square.js', pad + "const mul = require('./mul.js');\\nmodule.exports = (x) => mul(x, x);\\n");
  if (claude) fs.writeFileSync('square.test.js', "if (require('./square.js')(4) !== 16) throw new Error('square');\\n");
} else {
  fs.writeFileSync('mul.js', pad + 'module.exports = (a, b) => a * b;\\n');
  if (claude) fs.writeFileSync('mul.test.js', "if (require('./mul.js')(2, 3) !== 6) throw new Error('mul');\\n");
}
say('1. done\\n2. done\\n3. done\\n4. skipped: no user surface');
`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' }).trimEnd();
}

function concilium(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ['--import', tsxLoader, binPath, ...args], { cwd: sandbox, env, encoding: 'utf8' });
}

beforeAll(() => {
  writeFileSync(join(sandbox, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  mkdirSync(binDir);
  for (const cli of ['claude', 'codex'] as const) writeFileSync(join(binDir, cli), fakeAgentCli(cli), { mode: 0o755 });
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(binDir, 'git'));
  mkdirSync(join(repo, '.concilium'), { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'run-tests.js'), "for (const f of require('fs').readdirSync('.').filter((f) => f.endsWith('.test.js'))) require('./' + f);\n");
  // PATH holds only the fakes and git, so the gate names node by its absolute path.
  writeFileSync(join(repo, '.concilium', 'verify.yaml'), `gates:\n  test: '${JSON.stringify(process.execPath)} run-tests.js'\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  writeFileSync(join(sandbox, 'spec.md'), '# Math\n\nAdd multiply, then square on top of it.\n');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('concilium factory', () => {
  it('should run a two-task spec as two stacked integration branches, each verified at its own head, and push nothing', () => {
    const head = git(repo, 'rev-parse', 'HEAD');

    const result = concilium('factory', 'spec.md', '--cwd', repo, '--no-adversarial', '--no-judge');

    expect(result.stderr).toContain('Planned 2 tasks (mul, square)');
    expect(result.status).toBe(0);
    const id = /^Factory (\S+) in /m.exec(result.stdout)![1];
    const record = JSON.parse(readFileSync(join(runsDir, id, 'factory.json'), 'utf8')) as FactoryRecord;
    expect(record).toMatchObject({ status: 'done', baseSha: head, planner: 'claude', specPath: 'spec.md' });
    const [first, second] = record.steps;
    if (first.outcome !== 'shipped' || second.outcome !== 'shipped') throw new Error(result.stdout);

    // Stacked: the second task starts from the commit the first shipped, and each is verified at its own head.
    expect(first).toMatchObject({ taskId: 'mul', baseSha: head, branch: `concilium/${first.runId}/integration`, verdict: 'PASS' });
    expect(second).toMatchObject({ taskId: 'square', baseSha: first.headSha, branch: `concilium/${second.runId}/integration`, verdict: 'PASS' });
    git(repo, 'merge-base', '--is-ancestor', first.headSha, second.headSha);
    for (const step of [first, second]) {
      const run = JSON.parse(readFileSync(join(runsDir, step.runId, 'run.json'), 'utf8')) as CodeRunRecord;
      expect(run.prVerdict).toMatchObject({ verdict: 'PASS', headSha: step.headSha, gates: { test: 'pass' }, verifier: { provider: 'codex', sameFamily: false } });
      expect(git(repo, 'rev-parse', `${step.branch}~1`)).toBe(step.headSha); // the trail commit sits on top
    }
    expect(readFileSync(reviewLog, 'utf8')).toBe('codex\ncodex\n');
    expect(readFileSync(join(runsDir, id, 'tasks.md'), 'utf8')).toContain('## 1. mul: Add mul.js exporting a multiply function');

    // The summary: each task's run and verdict, and the pr commands that would ship the stack in order.
    expect(result.stdout).toMatch(new RegExp(`^  mul\\s+feature\\s+shipped\\s+${first.runId}\\s+${head.slice(0, 12)}\\s+${first.headSha.slice(0, 12)}\\s+PASS$`, 'm'));
    expect(result.stdout).toMatch(new RegExp(`^  square\\s+feature\\s+shipped\\s+${second.runId}\\s+${first.headSha.slice(0, 12)}`, 'm'));
    expect(result.stdout).toContain(`Nothing was pushed.`);
    expect(result.stdout).toContain(`  concilium pr ${first.runId}\n  concilium pr ${second.runId} --base concilium/${first.runId}\n`);

    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'remote')).toBe('');
    expect(existsSync(join(runsDir, first.runId, 'gates.json'))).toBe(false);

    // concilium status shows the factory again, and still a single task's run.
    const status = concilium('status', id);
    expect(status.status).toBe(0);
    expect(status.stdout).toBe(result.stdout);
    const run = concilium('status', second.runId);
    expect(run.stdout).toContain(`Verdict: PASS at ${second.headSha.slice(0, 12)}`);
    expect(run.stdout).toContain('  valid');
  }, 120_000);

  it('should refuse an author-family verifier before planning, and run it flagged same-family with --allow-same-family-verifier', () => {
    const refused = concilium('factory', 'spec.md', '--cwd', repo, '--no-adversarial', '--no-judge', '--role', 'verifier=claude');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Error: [verifier-author-family] --role verifier: verifier claude is of the anthropic family, which can write the code it verifies');
    expect(refused.stderr).not.toContain('Planned');

    const result = concilium('factory', 'spec.md', '--cwd', repo, '--no-adversarial', '--no-judge', '--role', 'verifier=claude', '--allow-same-family-verifier');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Warning: [verifier-author-family-allowed] --role verifier:');
    const id = /^Factory (\S+) in /m.exec(result.stdout)![1];
    const record = JSON.parse(readFileSync(join(runsDir, id, 'factory.json'), 'utf8')) as FactoryRecord;
    expect(record.steps.map((s) => [s.outcome, s.outcome === 'shipped' && s.sameFamily])).toEqual([['shipped', true], ['shipped', true]]);
    for (const step of record.steps) {
      if (step.outcome !== 'shipped') throw new Error(result.stdout);
      const run = JSON.parse(readFileSync(join(runsDir, step.runId, 'run.json'), 'utf8')) as CodeRunRecord;
      expect(run.prVerdict).toMatchObject({ verdict: 'PASS', verifier: { provider: 'claude', configured: true, sameFamily: true } });
    }
    expect(result.stdout).toMatch(/^  mul\s+feature\s+shipped\s+.*PASS \(same family\)$/m);
    expect(result.stdout).toContain('Warning: mul was verified by a CLI of an author family');
    expect(result.stdout).toContain('Warning: square was verified by a CLI of an author family');
  }, 120_000);

  it('should exit 1 on a spec file it cannot read', () => {
    const result = concilium('factory', 'missing.md', '--cwd', repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error: cannot read the spec file missing.md');
  });
});
