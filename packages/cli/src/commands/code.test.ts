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

/** The adversaries' tests: claude's checks the task (it fails on the base), codex's asks for the impossible. */
const ADVERSARIAL_TESTS = {
  claude: "let threw = false; try { require('./sum.js')('x', 1); } catch (e) { threw = e instanceof TypeError; } if (!threw) throw new Error('no TypeError');\n",
  codex: "if (require('./sum.js')(2, 2) !== 5) throw new Error('2 + 2 is not 5');\n",
};

/** The acceptance line of the ambiguous task: a separator, but which one? */
const AMBIGUOUS_LINE = "slugify('Hello World') joins the words with a separator";

/**
 * A fake agent CLI that edits files in its cwd, as the real one would in its worktree. `claude` adds input
 * validation and a test and succeeds; `codex` writes half a change, deletes `sum.test.js` and exits 1. Asked for the rubric (its cwd holds
 * only council-prompt.md), `claude` logs its argv and answers RUBRIC; `codex` fails as usual. As an adversary (its
 * worktree is `adv-<family>`), each writes its test from ADVERSARIAL_TESTS and the manifest; `codex` then exits 1.
 * Both answer detection as installed and signed in. Asked to judge, `claude` scores the candidate whose diff
 * holds `TypeError` 9 on every criterion and the others 3. Asked for grafts, `claude` names the first file of
 * candidate A's diff; as the integrator (its worktree is `integration`), it writes `grafted.js`. Asked for spec
 * questions, `claude` asks about AMBIGUOUS_LINE. Where an `AMBIGUOUS` file exists, each reads AMBIGUOUS_LINE its own
 * way (`claude` a hyphen, `codex` an underscore): it writes `slug.js` as a candidate, a test of its reading as an
 * adversary, and succeeds.
 */
function fakeAgentCli(cli: 'claude' | 'codex'): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (args === '--version') { console.log('1.0.0'); process.exit(0); }
if (args === 'auth status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0); }
if (args === 'login status') { console.log('Logged in using ChatGPT'); process.exit(0); }
const prompt = fs.existsSync('council-prompt.md') ? fs.readFileSync('council-prompt.md', 'utf8') : '';
if (${JSON.stringify(cli)} === 'claude' && prompt.startsWith('You are judging')) {
  const scores = prompt.split('## Candidate ').slice(1).flatMap((s) => ${JSON.stringify(RUBRIC.map((c) => c.name))}.map((criterion) => ({ candidate: s[0], criterion, score: s.includes('TypeError') ? 9 : 3, reason: 'read the diff' })));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ scores }) }));
  process.exit(0);
}
if (${JSON.stringify(cli)} === 'claude' && prompt.startsWith('You are choosing grafts')) {
  const file = /\\+\\+\\+ b\\/(\\S+)/.exec(prompt.split('## Candidate A')[1] ?? '')?.[1];
  const grafts = file ? [{ candidate: 'A', files: [file], instruction: 'Take its ' + file + '.', why: 'The base lacks it.' }] : [];
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ grafts }) }));
  process.exit(0);
}
if (${JSON.stringify(cli)} === 'claude' && prompt.startsWith('You are phrasing spec questions')) {
  const questions = [{ clause: ${JSON.stringify(AMBIGUOUS_LINE)}, question: 'Hyphen or underscore between the words?' }];
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ questions }) }));
  process.exit(0);
}
if (fs.existsSync('AMBIGUOUS')) {
  const sep = ${JSON.stringify(cli === 'claude' ? '-' : '_')};
  if (require('node:path').basename(process.cwd()).startsWith('adv-')) {
    fs.writeFileSync(${JSON.stringify(`${cli}-reading.test.js`)}, "if (require('./slug.js')('Hello World') !== 'hello" + sep + "world') throw new Error('other reading');\\n");
    fs.writeFileSync('concilium-adversarial.json', JSON.stringify({ tests: [{ files: [${JSON.stringify(`${cli}-reading.test.js`)}], specClause: ${JSON.stringify(AMBIGUOUS_LINE)} }] }));
  } else {
    fs.writeFileSync('slug.js', "module.exports = (s) => s.toLowerCase().split(' ').join('" + sep + "');\\n");
  }
  console.log(JSON.stringify(${JSON.stringify(cli)} === 'claude'
    ? { type: 'result', subtype: 'success', is_error: false, result: 'Done' }
    : { type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }));
  if (${JSON.stringify(cli)} === 'codex') console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
  process.exit(0);
}
if (${JSON.stringify(cli)} === 'claude' && require('node:path').basename(process.cwd()) === 'integration') {
  fs.writeFileSync('grafted.js', 'grafted\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Folded the graft in' }));
  process.exit(0);
}
if (require('node:path').basename(process.cwd()).startsWith('adv-')) {
  fs.writeFileSync(${JSON.stringify(`${cli}-adv.test.js`)}, ${JSON.stringify(ADVERSARIAL_TESTS[cli])});
  fs.writeFileSync('concilium-adversarial.json', JSON.stringify({ tests: [{ files: [${JSON.stringify(`${cli}-adv.test.js`)}], specClause: 'reject non-numbers' }] }));
  if (${JSON.stringify(cli)} === 'codex') process.exit(1);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Wrote a test' }));
  process.exit(0);
}
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
    // Two candidates, the base the gates ran on and the integration worktree; the integration branch is kept.
    expect(gc.stdout).toContain(`would remove 4 worktrees, would delete 3 branches, kept concilium/${record.id}/integration`);

    // claude won, so codex's half.js is grafted into it by a fresh claude run, and the patch applies to HEAD.
    const runDir = join(sandbox, 'data', 'concilium', 'runs', record.id);
    expect(record.synthesis).toMatchObject({
      base: { candidateId: 'claude', headSha: claude.headSha }, branch: `concilium/${record.id}/integration`,
      picker: { provider: 'claude', sameFamily: true }, dropouts: [],
      patchPath: join(runDir, 'result.patch'), synthesisPath: join(runDir, 'synthesis.md'),
      mergeable: true, mergeCheck: { applies: true, targetSha: head },
    });
    expect(record.synthesis!.grafts).toEqual([expect.objectContaining({ id: 'graft-1', candidateId: 'codex', files: ['half.js'], status: 'applied' })]);
    expect(git(repo, 'show', `concilium/${record.id}/integration:grafted.js`)).toBe('grafted');
    git(repo, 'apply', '--check', join(runDir, 'result.patch'));
    expect(readFileSync(join(runDir, 'synthesis.md'), 'utf8')).toContain('- **graft-1** from `codex` (`half.js`): Take its half.js.');

    // No gate tells them apart, so a judge orders them. Only claude and codex are installed, the tied families: claude judges, with a note.
    const sameFamilyReason = 'no CLI outside the tied families (anthropic, openai) is usable, so claude judges';
    expect(record.ranking.judgments).toEqual([expect.objectContaining({
      status: 'PASS', judge: 'claude', sameFamily: true, sameFamilyReason, candidates: ['claude', 'codex'], totals: { claude: 54, codex: 18 },
    })]);
    for (const c of record.candidates) expect(c.report!.evidence).toContainEqual({ kind: 'judge', ok: true, detail: `same-family judge: ${sameFamilyReason}` });
    expect(record.ranking).toMatchObject({ winner: 'claude', reason: 'tied on the evidence, ordered by the judge' });
    expect(claude.report).toMatchObject({ status: 'ISSUES', baseSha: head, headSha: claude.headSha, branch: claude.branch });
    expect(claude.report!.reason).toBe('the final message does not list playbook step 1, 2, 3, 4 as done or skipped');

    const unjudged = code('--json', '--no-judge', '--agents', 'claude,codex', 'add input validation to sum with a test');
    expect(unjudged.status).toBe(0);
    // codex adds one line in one file, claude changes three in two: without a judge the smaller diff wins the tie.
    expect((JSON.parse(unjudged.stdout) as CodeRunRecord).ranking).toMatchObject({
      winner: 'codex', judgments: [], reason: 'tie broken by smallest diff: claude, codex tie on the evidence and no judge ran; codex changes 1 line in 1 file',
    });

    // The summary warns about the same-family judge where the ranking is shown.
    const summary = code('--agents', 'claude,codex', 'add input validation to sum with a test');
    expect(summary.status).toBe(0);
    expect(summary.stdout).toContain(`Judge claude on claude, codex: PASS, scored 2 candidates on 3 criteria\n    Warning: same-family judge: ${sameFamilyReason}\n`);
    const summaryId = /Run (\S+) in /.exec(summary.stdout)![1];
    expect(summary.stderr).toMatch(/✓ graft-1 from codex \(half\.js\): applied at [0-9a-f]{12}\n/);
    expect(summary.stdout).toContain('Synthesis (base claude; grafts named by claude, each re-verified with the gates and the valid adversarial tests):');
    expect(summary.stdout).toContain(`Integration branch: concilium/${summaryId}/integration\n`);
    expect(summary.stdout).toContain(`Patch: ${join(sandbox, 'data', 'concilium', 'runs', summaryId, 'result.patch')}\n`);
    expect(summary.stdout).toMatch(/Mergeable: yes, git apply --check against HEAD [0-9a-f]{12}\n/);

    const unsynthesized = code('--json', '--no-synthesis', '--agents', 'claude,codex', 'add input validation to sum with a test');
    expect(unsynthesized.status).toBe(0);
    const plain = JSON.parse(unsynthesized.stdout) as CodeRunRecord;
    expect(plain.synthesis).toBeUndefined();
    expect(git(repo, 'branch', '--list', `concilium/${plain.id}/integration`)).toBe('');
    expect(existsSync(join(sandbox, 'data', 'concilium', 'runs', plain.id, 'result.patch'))).toBe(false);
  }, 120_000);

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
    expect(result.stdout).toMatch(/Rank\s+Candidate\s+Report\s+New failures\s+Survival\s+Penalties\s+Judge\n\s+1\s+claude\s+ISSUES\s+0\s+-\s+0\s+-\n/);
    expect(result.stdout).toContain('Winner: claude (best on the evidence)');
    expect(result.stdout).toMatch(/Reports:\n {4}claude: ISSUES at [0-9a-f]{12}, the final message does not list playbook step 1, 2, 3, 4, 5 as done or skipped\n/);
    expect(result.stdout).toContain('Synthesis skipped: fewer than 2 candidates');
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
    expect(result.stdout).toMatch(/1\s+claude\s+ISSUES\s+0\s+1\/1\s+0\s+-\n\s+2\s+codex\s+ISSUES \(disqualified\)\s+1\s+0\/1\s+0\s+-\n/);
    expect(result.stdout).toContain('codex: ISSUES at');
    expect(result.stdout).toContain('disqualify: deleted the test file sum.test.js; survived 0/1 adversarial tests by other families, failed anthropic-1;');
    expect(result.stdout).toContain('Winner: claude (best on the evidence)');
    expect(result.stdout).not.toContain('same-family judge');

    const skipped = code('--json', '--no-verify', '--agents', 'claude', 'add input validation to sum');
    expect(skipped.status).toBe(0);
    const record = JSON.parse(skipped.stdout) as CodeRunRecord;
    expect(record.verification).toBeUndefined();
    expect(skipped.stderr).not.toContain('gate test');
    expect(git(repo, 'branch', '--list', `concilium/${record.id}/base`)).toBe('');
    expect(record.adversarial).toMatchObject({ skipped: 'the gates did not run' });
  }, 30_000);

  it('should run each adversary\'s tests on the base and every candidate and print the survival matrix', () => {
    // The test gate now runs every *.test.js, so an adversarial test copied into a worktree runs with the suite.
    writeFileSync(join(repo, 'run-tests.js'), [
      "const fs = require('node:fs');",
      'let failed = 0;',
      "for (const f of fs.readdirSync('.').filter((f) => f.endsWith('.test.js'))) { try { require('./' + f); } catch (e) { failed++; console.error(f + ': ' + e.message); } }",
      'process.exit(failed ? 1 : 0);',
      '',
    ].join('\n'));
    writeFileSync(join(repo, '.concilium', 'verify.yaml'), `gates:\n  test: '${JSON.stringify(process.execPath)} run-tests.js'\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'run every test');

    const result = code('--agents', 'claude,codex', 'sum must reject non-numbers');

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('✓ anthropic-1 on claude: pass');
    expect(result.stderr).toContain('✗ adv-openai: error');
    expect(result.stdout).toContain('Adversarial tests (one adversary per family, run with');
    expect(result.stdout).toMatch(/adv-anthropic \(claude\): ok, 1 tests\n/);
    expect(result.stdout).toMatch(/adv-openai \(codex\): error, 1 tests; codex exited with code 1/);
    expect(result.stdout).toMatch(/Test\s+Validity\s+base\s+claude\s+codex\s+Clause\n/);
    // claude's test passes only on claude, its own family: it carries no weight against codex.
    expect(result.stdout).toMatch(/anthropic-1\s+own-family-only\s+fail\s+pass\s+fail\s+reject non-numbers\n/);
    expect(result.stdout).toMatch(/openai-1\s+quarantined\s+fail\s+fail\s+fail\s+reject non-numbers\n/);
    expect(result.stdout).toContain('Survival (valid tests by other families):\n    claude: 0/0\n    codex: 0/0\n');
    const runId = /Run (\S+) in /.exec(result.stdout)![1];
    expect(git(repo, 'show', `concilium/${runId}/adv-anthropic:claude-adv.test.js`)).toContain('TypeError');
    // The candidates' branches never get the adversarial tests.
    expect(git(repo, 'ls-tree', '--name-only', `concilium/${runId}/claude`)).not.toContain('adv.test.js');
    expect(git(repo, 'status', '--porcelain')).toBe('');

    const skipped = code('--json', '--no-adversarial', '--agents', 'claude,codex', 'sum must reject non-numbers');
    expect(skipped.status).toBe(0);
    const record = JSON.parse(skipped.stdout) as CodeRunRecord;
    expect(record.verification).toBeDefined();
    expect(record.adversarial).toBeUndefined();
    expect(git(repo, 'branch', '--list', `concilium/${record.id}/adv-*`)).toBe('');
  }, 60_000);

  it('should exit 2 with the spec questions and no patch when the candidates read one line two ways', () => {
    // Runs last: from here on the fakes read the task's acceptance line two ways.
    writeFileSync(join(repo, 'AMBIGUOUS'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'ambiguous');
    const task = `Add slugify(text) in slug.js. Acceptance: ${AMBIGUOUS_LINE}`;

    const result = code('--json', '--agents', 'claude,codex', task);
    expect(result.status).toBe(2);
    const record = JSON.parse(result.stdout) as CodeRunRecord;
    const runDir = join(sandbox, 'data', 'concilium', 'runs', record.id);
    expect(record.status).toBe('reframe-needed');
    expect(record.reframe).toMatchObject({
      phraser: 'claude', source: 'phraser', reportPath: join(runDir, 'reframe.md'),
      divergence: [{ trigger: 'disjoint-survival', conflicts: [{ clause: AMBIGUOUS_LINE }] }],
      questions: [{ clause: AMBIGUOUS_LINE, question: 'Hyphen or underscore between the words?' }],
    });
    expect(record.synthesis).toMatchObject({ skipped: 'the candidates diverge (disjoint-survival), so the task needs a reframe' });
    expect(existsSync(join(runDir, 'result.patch'))).toBe(false);
    expect(git(repo, 'branch', '--list', `concilium/${record.id}/integration`)).toBe('');
    expect(readFileSync(join(runDir, 'reframe.md'), 'utf8')).toContain(`1. On "${AMBIGUOUS_LINE}": Hyphen or underscore between the words?`);
    expect((JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as CodeRunRecord).status).toBe('reframe-needed');

    const summary = code('--agents', 'claude,codex', task);
    expect(summary.status).toBe(2);
    expect(summary.stderr).toMatch(/✗ reframe needed: 1 questions in \S+reframe\.md\n/);
    expect(summary.stdout).toContain('Synthesis skipped: the candidates diverge (disjoint-survival), so the task needs a reframe');
    expect(summary.stdout).toContain('Reframe needed: the candidates diverge, so the task can be read more than one way. No patch was written.');
    expect(summary.stdout).toContain(`"${AMBIGUOUS_LINE}": claude passes anthropic-1, fails openai-1; codex passes openai-1, fails anthropic-1`);
    expect(summary.stdout).toContain(`Questions (phrased by claude):\n    1. On "${AMBIGUOUS_LINE}": Hyphen or underscore between the words?\n`);

    // Without synthesis there is nothing to blend, so nothing is checked: exit 0.
    const plain = code('--json', '--no-synthesis', '--agents', 'claude,codex', task);
    expect(plain.status).toBe(0);
    expect((JSON.parse(plain.stdout) as CodeRunRecord).status).toBe('done');
  }, 60_000);
});
