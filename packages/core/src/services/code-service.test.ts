/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAYBOOKS, TASK_TYPES } from '../domain/code-council/playbooks.js';
import { rubricHash, type RubricCriterion } from '../domain/code-council/rubric.js';
import type { Brief } from '../domain/driver/brief.js';
import type { RunEvent } from '../domain/driver/normalized-event.js';
import { COUNCIL_PROMPT_FILE } from '../adapters/cli/cli-council-gateway.js';
import { FakeCliDriver } from '../adapters/cli/fake-cli-driver.js';
import { DirtyWorktreeError, GitWorktreeWorkspace } from '../adapters/git-worktree-workspace.js';
import { JsonCodeRunStore } from '../adapters/json-code-run-store.js';
import { setLogLevel } from '../shared/logger.js';
import { codeBrief, runCodeCandidates } from './code-service.js';

const sandbox = mkdtempSync(join(tmpdir(), 'concilium-code-test-'));
const gitConfig = join(sandbox, 'gitconfig');
let repo: string;
let workspace: GitWorktreeWorkspace;
let counter = 0;

const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[name];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trimEnd();
}

beforeAll(() => {
  setLogLevel('error');
  writeFileSync(gitConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  counter += 1;
  repo = join(sandbox, `repo-${counter}`);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  workspace = new GitWorktreeWorkspace({ root: join(sandbox, `worktrees-${counter}`) });
});

/** A fake agent CLI that edits files in the directory it runs in, as a real one would. */
function writer(id: string, files: Record<string, string>, outcome: 'ok' | 'error' = 'ok'): FakeCliDriver {
  return new FakeCliDriver({
    id,
    respond: (brief: Brief) => {
      for (const [name, content] of Object.entries(files)) writeFileSync(join(brief.cwd, name), content);
      return outcome === 'ok'
        ? [{ type: 'text', text: `${id} done` }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }]
        : [{ type: 'error', message: `${id} crashed` }];
    },
  });
}

function codeRuns(driver: FakeCliDriver) {
  return driver.runs.filter((run) => run.brief.mode === 'code');
}

const TAILORED: RubricCriterion[] = [
  { name: 'repro', description: 'A test fails on empty input before the fix.', weight: 3, evidence: 'gate' },
  { name: 'suite', description: 'The existing tests pass.', weight: 2, evidence: 'gate' },
  { name: 'small', description: 'Only sum.js changes.', weight: 1, evidence: 'judgment' },
];

/**
 * A fake CLI that answers the rubric prompt (a read-only brief pointing at council-prompt.md) with `answer`,
 * and writes `files` when it gets a code brief. `order` records every run as it starts.
 */
function framerAndWriter(id: string, answer: string | null, order: string[], files: Record<string, string> = { 'x.txt': 'x\n' }): FakeCliDriver {
  return new FakeCliDriver({
    id,
    respond: (brief: Brief) => {
      order.push(`${id}:${brief.mode}`);
      if (brief.mode === 'plan') {
        expect(readFileSync(join(brief.cwd, COUNCIL_PROMPT_FILE), 'utf8')).toContain('Write the rubric their work will be judged on');
        return answer === null ? [{ type: 'error', message: 'framer down' }] : [{ type: 'text', text: answer }];
      }
      for (const [name, content] of Object.entries(files)) writeFileSync(join(brief.cwd, name), content);
      return [{ type: 'text', text: `${id} done` }];
    },
  });
}

describe('codeBrief', () => {
  it.each(TASK_TYPES)('should hold the %s playbook steps and verification verbatim, and never the rubric', (type) => {
    const brief = codeBrief('do the task', { type, source: 'flag', reason: 'set with --type' }, '/wt/claude', 'concilium/r/claude');

    for (const step of PLAYBOOKS[type].steps) expect(brief.task).toContain(step);
    for (const line of PLAYBOOKS[type].verification) expect(brief.task).toContain(line);
    for (const c of PLAYBOOKS[type].rubric) expect(brief.task).not.toContain(c.description);
    expect(brief.task).not.toMatch(/rubric|sha256/i);
    expect(brief.task).toMatchSnapshot();
  });
});

describe('runCodeCandidates', () => {
  it('should run each agent in its own worktree and put its changes on its branch, leaving the checkout untouched', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const drivers = new Map([
      ['claude', writer('claude', { 'sum.js': 'module.exports = (a, b) => Number(a) + Number(b);\n', 'sum.test.js': 'test\n' })],
      ['codex', writer('codex', { 'sum.js': '// codex\nmodule.exports = (a, b) => a + b;\n' }, 'error')],
      ['gemini', new FakeCliDriver({ id: 'gemini', events: [{ type: 'text', text: 'nothing to do' }] })],
    ]);

    const record = await runCodeCandidates({
      task: 'validate the inputs of sum',
      repoDir: repo,
      agents: [{ provider: 'claude' }, { provider: 'codex', model: 'gpt-5.2' }, { provider: 'gemini' }, { provider: 'opencode' }],
      runId: 'run1',
      drivers,
      workspace,
    });

    expect(record).toMatchObject({ id: 'run1', kind: 'code', headSha: head, baseSha: head, task: 'validate the inputs of sum' });
    const [claude, codex, gemini, opencode] = record.candidates;

    expect(claude).toMatchObject({
      candidateId: 'claude', status: 'ok', branch: 'concilium/run1/claude', committed: true, finalText: 'claude done',
      usage: { inputTokens: 10, outputTokens: 5 }, errors: [],
      diffStat: { commits: 1, filesChanged: 2, insertions: 2, deletions: 1 },
    });
    expect(claude.headSha).toBe(git(repo, 'rev-parse', 'concilium/run1/claude'));
    expect(git(repo, 'show', 'concilium/run1/claude:sum.js')).toContain('Number(a)');
    expect(git(repo, 'show', 'concilium/run1/claude:sum.test.js')).toBe('test');
    expect(git(repo, 'log', '-1', '--format=%an%n%B', 'concilium/run1/claude')).toContain('concilium\nconcilium: claude candidate for run run1\n\nTask: validate the inputs of sum');

    // A failed candidate keeps what it wrote, and does not stop the others.
    expect(codex).toMatchObject({ status: 'error', model: 'gpt-5.2', committed: true, errors: ['codex crashed'] });
    expect(git(repo, 'show', 'concilium/run1/codex:sum.js')).toContain('// codex');

    expect(gemini).toMatchObject({ status: 'ok', committed: false, headSha: head, diffStat: { commits: 0, filesChanged: 0 } });
    expect(opencode).toMatchObject({ status: 'error', errors: ['No agent CLI driver for "opencode"'] });

    // Each agent got a write-mode brief in its own worktree, never the checkout.
    for (const driver of ['claude', 'codex']) {
      const [{ brief, opts }] = codeRuns(drivers.get(driver)!);
      expect(brief).toMatchObject({ mode: 'code', allowedActions: ['read', 'write', 'shell'] });
      expect(brief.task.startsWith('validate the inputs of sum\n\n## Playbook: feature\n')).toBe(true);
      expect(brief.cwd).toBe(record.candidates.find((c) => c.provider === driver)!.worktree);
      expect(opts.cwd).toBe(brief.cwd);
      expect(brief.cwd.startsWith(repo)).toBe(false);
    }
    expect(codeRuns(drivers.get('codex')!)[0].opts.model).toBe('gpt-5.2');

    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');

    // The run is finished, so gc collects it instead of skipping it as active; worktrees stay until then.
    const [gcPlan] = await workspace.gc({ runId: 'run1', dryRun: true });
    expect(gcPlan.skipped).toBeUndefined();
    expect(gcPlan.removedWorktrees).toHaveLength(4);
  });

  it('should name a second agent of the same CLI apart', async () => {
    const drivers = new Map([['claude', writer('claude', { 'x.txt': 'x\n' })]]);
    const record = await runCodeCandidates({ task: 't', repoDir: repo, agents: [{ provider: 'claude' }, { provider: 'claude', model: 'opus' }], runId: 'run2', drivers, workspace });
    expect(record.candidates.map((c) => c.branch)).toEqual(['concilium/run2/claude', 'concilium/run2/claude-2']);
  });

  it('should refuse a dirty checkout unless includeDirty, which starts every candidate from the dirty bytes', async () => {
    writeFileSync(join(repo, 'sum.js'), 'dirty\n');
    const drivers = new Map([['claude', writer('claude', { 'more.txt': 'm\n' })]]);
    const input = { task: 't', repoDir: repo, agents: [{ provider: 'claude' }], drivers, workspace };

    await expect(runCodeCandidates({ ...input, runId: 'run3' })).rejects.toBeInstanceOf(DirtyWorktreeError);
    expect(drivers.get('claude')!.runs).toHaveLength(0);

    const record = await runCodeCandidates({ ...input, runId: 'run4', includeDirty: true });
    expect(record.baseSha).not.toBe(record.headSha);
    expect(git(repo, 'show', 'concilium/run4/claude:sum.js')).toBe('dirty');
    expect(record.candidates[0].diffStat).toMatchObject({ commits: 1, filesChanged: 1 });
    expect(git(repo, 'status', '--porcelain')).toBe(' M sum.js');
  });

  it('should freeze a rubric tailored by the first agent before any candidate starts, and keep it from every candidate', async () => {
    const order: string[] = [];
    const drivers = new Map([
      ['claude', framerAndWriter('claude', `\`\`\`json\n${JSON.stringify({ criteria: TAILORED })}\n\`\`\``, order)],
      ['codex', framerAndWriter('codex', null, order)],
    ]);
    const framed: string[] = [];
    const record = await runCodeCandidates({
      task: 'sum crashes on empty input',
      repoDir: repo,
      agents: [{ provider: 'claude', model: 'opus' }, { provider: 'codex' }],
      type: 'bugfix',
      runId: 'run6',
      drivers,
      workspace,
      onFramed: (frame) => framed.push(`${frame.taskType.type} ${frame.rubric.sha256}`),
      onCandidateStart: (c) => framed.push(`start ${c.candidateId}`),
    });

    expect(record.taskType).toEqual({ type: 'bugfix', source: 'flag', reason: 'set with --type' });
    expect(record.rubric).toMatchObject({ criteria: TAILORED, source: 'framer', framer: 'claude:opus', sha256: rubricHash(TAILORED) });
    expect(record.rubric.note).toBeUndefined();
    expect(drivers.get('claude')!.runs[0].opts.model).toBe('opus');

    // One read-only framing run, then the candidates; the hash was announced before the first one started.
    expect(order.slice(0, 1)).toEqual(['claude:plan']);
    expect(order.slice(1).sort()).toEqual(['claude:code', 'codex:code']);
    expect(framed[0]).toBe(`bugfix ${record.rubric.sha256}`);
    expect(new Date(record.rubric.frozenAt).getTime()).toBeLessThanOrEqual(new Date(record.finishedAt).getTime());

    for (const candidate of record.candidates) {
      expect(candidate.brief!.task).toContain(PLAYBOOKS.bugfix.steps[0]);
      expect(candidate.brief!.task).not.toContain(record.rubric.sha256);
      for (const c of TAILORED) expect(candidate.brief!.task).not.toContain(c.description);
    }
  });

  it('should fall back to the playbook rubric when the framer fails or answers a bad rubric, and classify without a type', async () => {
    const order: string[] = [];
    const failing = await runCodeCandidates({
      task: 'fix the crash in sum', repoDir: repo, agents: [{ provider: 'codex' }], runId: 'run7',
      drivers: new Map([['codex', framerAndWriter('codex', null, order)]]), workspace,
    });
    expect(failing.taskType).toEqual({ type: 'bugfix', source: 'classifier', reason: 'the task mentions "fix"' });
    expect(failing.rubric).toMatchObject({ criteria: PLAYBOOKS.bugfix.rubric, source: 'playbook', framer: 'codex', note: 'codex gave no answer' });
    expect(failing.rubric.sha256).toBe(rubricHash(PLAYBOOKS.bugfix.rubric));
    expect(failing.candidates[0].status).toBe('ok');

    const tooFew = JSON.stringify({ criteria: TAILORED.slice(0, 2) });
    const rejected = await runCodeCandidates({
      task: 'make sum faster', repoDir: repo, agents: [{ provider: 'claude' }], runId: 'run8',
      drivers: new Map([['claude', framerAndWriter('claude', tooFew, order)]]), workspace,
    });
    expect(rejected.taskType.type).toBe('perf');
    expect(rejected.rubric).toMatchObject({ criteria: PLAYBOOKS.perf.rubric, source: 'playbook', framer: 'claude' });
    expect(rejected.rubric.note).toContain('must hold 3 to 6 criteria, got 2');
    expect(rejected.candidates[0].brief!.task).not.toContain(rubricHash(PLAYBOOKS.perf.rubric));
  });

  it('should save the record under runs/<id>/run.json', async () => {
    const drivers = new Map([['claude', writer('claude', { 'x.txt': 'x\n' })]]);
    const record = await runCodeCandidates({ task: 't', repoDir: repo, agents: [{ provider: 'claude' }], runId: 'run5', drivers, workspace });
    const store = new JsonCodeRunStore(join(sandbox, `data-${counter}`));

    expect(await store.save(record)).toBe(join(sandbox, `data-${counter}`, 'runs', 'run5', 'run.json'));
    expect(await store.load('run5')).toEqual(record);
  });
});

describe('runCodeCandidates with verify', () => {
  const SUM_TEST = [
    "const sum = require('./sum.js');",
    'const it = (name, fn) => fn();',
    'it.skip = () => {};',
    "it('adds', () => { if (sum(1, 2) !== 3) throw new Error('sum(1, 2) is ' + sum(1, 2)); });",
    '',
  ].join('\n');

  /** A repo whose test gate passes on the base and whose lint gate already fails there. */
  function seedGates(): string {
    writeFileSync(join(repo, 'sum.test.js'), SUM_TEST);
    writeFileSync(join(repo, 'lint.js'), "console.error('lint: 2 problems'); process.exit(1);\n");
    mkdirSync(join(repo, '.concilium'));
    writeFileSync(join(repo, '.concilium', 'verify.yaml'), 'gates:\n  test: node sum.test.js\n  lint: node lint.js\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'gates');
    return git(repo, 'rev-parse', 'HEAD');
  }

  /** A fake agent CLI that changes files in its worktree; null deletes the file. */
  function editor(id: string, files: Record<string, string | null>): FakeCliDriver {
    return new FakeCliDriver({
      id,
      respond: (brief: Brief) => {
        for (const [name, content] of Object.entries(files)) {
          if (content === null) rmSync(join(brief.cwd, name));
          else writeFileSync(join(brief.cwd, name), content);
        }
        return [{ type: 'text', text: `${id} done` }];
      },
    });
  }

  it('should hold only new gate failures against a candidate and disqualify one that deletes or skips a test', async () => {
    const baseSha = seedGates();
    const drivers = new Map([
      ['claude', editor('claude', { 'sum.js': 'module.exports = (a, b) => Number(a) + Number(b);\n' })],
      // Breaks the sum and tries to switch the gates off: the gates come from the base, so that only costs a penalty.
      ['codex', editor('codex', { 'sum.js': 'module.exports = (a, b) => a - b;\n', '.concilium/verify.yaml': 'gates:\n  test: "true"\n' })],
      ['gemini', editor('gemini', { 'sum.js': 'module.exports = (a, b) => a - b;\n', 'sum.test.js': null })],
      ['opencode', editor('opencode', { 'sum.js': 'module.exports = (a, b) => a - b;\n', 'sum.test.js': SUM_TEST.replace("it('adds'", "it.skip('adds'") })],
    ]);
    const gateLog: string[] = [];

    const record = await runCodeCandidates({
      task: 'make sum accept numeric strings', repoDir: repo, runId: 'verify1', drivers, workspace, verify: true,
      agents: [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'gemini' }, { provider: 'opencode' }],
      onGateDone: (lane, result) => gateLog.push(`${lane} ${result.name} ${result.outcome}`),
    });

    // The gates come from the base's verify.yaml and run once on the base, in its own worktree at baseSha.
    expect(record.verification!.plan).toMatchObject({ source: 'verify.yaml', gates: [{ name: 'test' }, { name: 'lint' }] });
    expect(record.verification!.baseline).toMatchObject({ lane: 'base', sha: baseSha });
    expect(record.verification!.baseline!.gates.map((g) => [g.name, g.outcome, g.sha])).toEqual([['test', 'pass', baseSha], ['lint', 'fail', baseSha]]);
    expect(record.verification!.baseline!.gates[1]).toMatchObject({ command: 'node lint.js', exitCode: 1, output: 'lint: 2 problems\n' });
    expect(gateLog.slice(0, 2)).toEqual(['base test pass', 'base lint fail']);

    const [claude, codex, gemini, opencode] = record.candidates;
    for (const c of record.candidates) expect(c.verification!.gates.every((g) => g.sha === c.headSha)).toBe(true);

    // lint fails everywhere, base included: reported as baseline, never held against a candidate.
    expect(claude.verification).toMatchObject({ status: 'PASS', newFailures: [], integrity: [], disqualified: false, penalties: 0, errors: [] });
    expect(claude.verification!.gates.map((g) => [g.name, g.verdict])).toEqual([['test', 'pass'], ['lint', 'baseline-failure']]);

    expect(codex.verification).toMatchObject({ status: 'ISSUES', newFailures: ['test'], disqualified: false, penalties: 1 });
    expect(codex.verification!.gates[0]).toMatchObject({ name: 'test', command: 'node sum.test.js', outcome: 'fail', verdict: 'new-failure' });
    expect(codex.verification!.gates[0].output).toContain('sum(1, 2) is -1');
    expect(codex.verification!.integrity).toEqual([expect.objectContaining({ rule: 'gate-config', path: '.concilium/verify.yaml' })]);

    expect(gemini.verification).toMatchObject({ status: 'ISSUES', newFailures: ['test'], disqualified: true });
    expect(gemini.verification!.integrity).toEqual([expect.objectContaining({
      rule: 'deleted-test', severity: 'disqualify', path: 'sum.test.js', evidence: expect.stringContaining("-it('adds'"),
    })]);

    // Skipping the test makes the gate pass, and disqualifies the candidate.
    expect(opencode.verification).toMatchObject({ status: 'ISSUES', newFailures: [], disqualified: true });
    expect(opencode.verification!.integrity).toEqual([expect.objectContaining({
      rule: 'skipped-test', path: 'sum.test.js', evidence: expect.stringContaining("+it.skip('adds'"),
    })]);

    // The base lane is a scratch worktree like the candidates', collected by gc with the run.
    expect(git(repo, 'rev-parse', 'concilium/verify1/base')).toBe(baseSha);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const gc = await workspace.gc({ runId: 'verify1', dryRun: true });
    expect(gc[0].deletedBranches).toContain('concilium/verify1/base');
  });

  it('should not verify unless asked, and skip the adversarial round without the gates', async () => {
    seedGates();
    const drivers = new Map([['claude', writer('claude', { 'x.txt': 'x\n' })]]);
    const record = await runCodeCandidates({ task: 't', repoDir: repo, agents: [{ provider: 'claude' }], runId: 'verify2', drivers, workspace });
    expect(record.verification).toBeUndefined();
    expect(record.candidates[0].verification).toBeUndefined();
    expect(record.adversarial).toBeUndefined();
    expect(git(repo, 'branch', '--list', 'concilium/verify2/base')).toBe('');

    const unverified = await runCodeCandidates({
      task: 't', repoDir: repo, agents: [{ provider: 'claude' }, { provider: 'claude' }], runId: 'verify3', drivers, workspace, adversarial: true,
    });
    expect(unverified.adversarial).toMatchObject({ skipped: 'the gates did not run', tests: [] });
  });
});

describe('runCodeCandidates with adversarial', () => {
  /** Runs every `*.test.js` under the worktree; any that throws fails the suite. */
  const RUN_TESTS = [
    "const fs = require('node:fs'); const path = require('node:path');",
    'const files = [];',
    "(function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === '.git') continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.test.js')) files.push(p); } })('.');",
    'let failed = 0;',
    "for (const f of files) { try { require(path.resolve(f)); } catch (e) { failed++; console.error(f + ': ' + e.message); } }",
    'process.exit(failed ? 1 : 0);',
    '',
  ].join('\n');
  const throwsOn = (args: string, from = '.') =>
    `const sum = require('${from}/sum.js'); let threw = false; try { sum(${args}); } catch (e) { threw = e instanceof TypeError; } if (!threw) throw new Error(${JSON.stringify(`sum(${args}) did not throw`)});\n`;
  const TASK = 'sum must reject an argument that is not a number with a TypeError';

  function seedSuite(): string {
    writeFileSync(join(repo, 'run-tests.js'), RUN_TESTS);
    writeFileSync(join(repo, 'sum.test.js'), "if (require('./sum.js')(1, 2) !== 3) throw new Error('1 + 2');\n");
    mkdirSync(join(repo, '.concilium'));
    writeFileSync(join(repo, '.concilium', 'verify.yaml'), 'gates:\n  test: node run-tests.js\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'suite');
    return git(repo, 'rev-parse', 'HEAD');
  }

  /**
   * A fake CLI that, as a candidate, writes `sum.js`; as an adversary (its brief says so), writes `tests` and a
   * manifest naming them with `extra` entries. `seen` records each adversary's cwd and the patches it was given.
   */
  function agent(id: string, sum: string, tests: Record<string, string>, seen: Record<string, { cwd: string; patches: string[] }>, extra: object[] = []): FakeCliDriver {
    return new FakeCliDriver({
      id,
      respond: (brief: Brief) => {
        if (!brief.task.startsWith('You are an adversary')) {
          writeFileSync(join(brief.cwd, 'sum.js'), sum);
          return [{ type: 'text', text: `${id} done` }];
        }
        const patches = brief.constraints.filter((c) => c.startsWith('Candidate diff, read-only: ')).map((c) => readFileSync(c.slice(27), 'utf8'));
        seen[id] = { cwd: brief.cwd, patches };
        if (Object.keys(tests).length === 0) return [{ type: 'text', text: 'no tests' }];
        for (const [name, content] of Object.entries(tests)) {
          mkdirSync(dirname(join(brief.cwd, name)), { recursive: true });
          writeFileSync(join(brief.cwd, name), content);
        }
        const manifest = [...Object.keys(tests).map((name, i) => ({ files: [name], specClause: `clause ${i + 1}` })), ...extra];
        writeFileSync(join(brief.cwd, 'concilium-adversarial.json'), JSON.stringify({ tests: manifest }));
        return [{ type: 'text', text: `${id} attacked` }];
      },
    });
  }

  it('should build the survival matrix on the base and every candidate and apply the validity rule', async () => {
    const baseSha = seedSuite();
    const seen: Record<string, { cwd: string; patches: string[] }> = {};
    const good = 'module.exports = (a, b) => { if (typeof a !== "number" || typeof b !== "number") throw new TypeError("not a number"); return a + b; };\n';
    const drivers = new Map([
      // Validates both arguments. Its adversary (anthropic) finds that codex misses the second one.
      ['claude', agent('claude', good, {
        'adv/second.test.js': throwsOn("1, 'x'", '..'),
        'adv/everywhere.test.js': "if (require('../sum.js')(2, 2) !== 5) throw new Error('2 + 2 is not 5');\n",
        'adv/adds.test.js': "if (require('../sum.js')(2, 3) !== 5) throw new Error('2 + 3');\n",
      }, seen)],
      // Validates only the first argument. Its adversary (openai) writes a test both pass, and lists a non-test file.
      ['codex', agent('codex', 'module.exports = (a, b) => { if (typeof a !== "number") throw new TypeError("a"); return a + b; };\n', {
        'first.test.js': throwsOn("'x', 1"),
      }, seen, [{ files: ['sum.js'], specClause: 'cheat' }])],
      // Breaks the suite, so no adversarial test can be judged on it; its adversary writes no manifest.
      ['gemini', agent('gemini', 'module.exports = () => 0;\n', {}, seen)],
    ]);
    const cells: string[] = [];

    const record = await runCodeCandidates({
      task: TASK, repoDir: repo, runId: 'adv1', drivers, workspace, verify: true, adversarial: true, timeoutMs: 60_000,
      agents: [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'gemini' }],
      onTestDone: (testId, lane, cell) => cells.push(`${testId} ${lane} ${cell}`),
    });
    const round = record.adversarial!;
    const [claude, codex, gemini] = record.candidates;

    expect(round.skipped).toBeUndefined();
    expect(round.testCommand).toBe('node run-tests.js');
    expect(round.matrix).toEqual({
      'anthropic-1': { base: 'fail', claude: 'pass', codex: 'fail', gemini: 'error' },
      'anthropic-2': { base: 'fail', claude: 'fail', codex: 'fail', gemini: 'error' },
      'anthropic-3': { base: 'pass', claude: 'pass', codex: 'pass', gemini: 'error' },
      'openai-1': { base: 'fail', claude: 'pass', codex: 'pass', gemini: 'error' },
    });
    expect(cells).toHaveLength(16);
    expect(round.tests.map((t) => [t.id, t.author, t.files, t.specClause, t.validity])).toEqual([
      // It passes only on claude, of its author's family: no other family shows it can be met.
      ['anthropic-1', 'anthropic', ['adv/second.test.js'], 'clause 1', 'own-family-only'],
      ['anthropic-2', 'anthropic', ['adv/everywhere.test.js'], 'clause 2', 'quarantined'],
      ['anthropic-3', 'anthropic', ['adv/adds.test.js'], 'clause 3', 'regression-guard'],
      // It passes on claude, of another family than its author.
      ['openai-1', 'openai', ['first.test.js'], 'clause 1', 'evidence'],
    ]);
    // An author's own tests carry no weight for it; own-family-only and quarantined ones carry none for anyone.
    expect(round.survival).toEqual({
      claude: { counted: 1, survived: 1, failed: [] },
      codex: { counted: 1, survived: 1, failed: [] },
      gemini: { counted: 2, survived: 0, failed: ['anthropic-3', 'openai-1'] },
    });
    // Each run is recorded at the lane's SHA, with the output of failures.
    const killed = round.runs.find((r) => r.testId === 'anthropic-1' && r.lane === 'codex')!;
    expect(killed).toMatchObject({ outcome: 'fail', sha: codex.headSha });
    expect(killed.output).toContain("sum(1, 'x') did not throw");
    expect(round.runs.find((r) => r.lane === 'base')!.sha).toBe(baseSha);
    expect(round.runs.some((r) => r.lane === 'gemini')).toBe(false);

    // One adversary per family, from the base in its own worktree, with the other families' diffs and not its own.
    const [anthropic, openai, google] = round.adversaries;
    expect(anthropic).toMatchObject({ family: 'anthropic', provider: 'claude', lane: 'adv-anthropic', status: 'ok', peers: ['codex', 'gemini'], notes: [] });
    expect(openai).toMatchObject({ family: 'openai', peers: ['claude', 'gemini'], notes: ['tests[1] dropped: sum.js is not a test file'] });
    expect(google).toMatchObject({ family: 'google', status: 'error', errors: ['wrote no concilium-adversarial.json'] });
    expect(seen.claude.cwd).toBe(anthropic.worktree);
    expect(seen.claude.patches.join('\n')).toContain('if (typeof a !== "number") throw new TypeError("a")');
    expect(seen.claude.patches.join('\n')).not.toContain('typeof b');
    expect(anthropic.brief).toMatchObject({ mode: 'code', allowedActions: ['read', 'write', 'shell'] });
    expect(anthropic.brief!.task).toContain(TASK);
    const adversaryRun = drivers.get('claude')!.runs.find((r) => r.brief.task.startsWith('You are an adversary'))!;
    expect(adversaryRun.opts.timeoutMs).toBe(60_000);
    // The patch files are gone after the round; the tests are on the adversary's branch.
    for (const c of anthropic.brief!.constraints.filter((c) => c.startsWith('Candidate diff'))) expect(existsSync(c.slice(27))).toBe(false);
    expect(git(repo, 'show', `${anthropic.branch}:adv/second.test.js`)).toContain("sum(1, 'x')");
    expect(git(repo, 'rev-parse', anthropic.branch)).toBe(anthropic.headSha);

    // Candidate branches and worktrees are as the candidates left them.
    for (const c of [claude, codex, gemini]) {
      expect(git(repo, 'rev-parse', c.branch)).toBe(c.headSha);
      expect(git(c.worktree, 'status', '--porcelain')).toBe('');
    }
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const gc = await workspace.gc({ runId: 'adv1', dryRun: true });
    expect(gc[0].deletedBranches).toEqual(expect.arrayContaining(['concilium/adv1/adv-anthropic', 'concilium/adv1/adv-openai', 'concilium/adv1/adv-google']));
  });

  it('should drop a test that passes on the base of a bug fix, and skip the round with fewer than 2 candidates', async () => {
    seedSuite();
    const seen: Record<string, { cwd: string; patches: string[] }> = {};
    const drivers = new Map([
      ['claude', agent('claude', 'module.exports = (a, b) => a + b;\n', { 'adds.test.js': "if (require('./sum.js')(2, 3) !== 5) throw new Error('2 + 3');\n" }, seen)],
      ['codex', agent('codex', 'module.exports = (a, b) => a + b;\n', {}, seen)],
    ]);
    const record = await runCodeCandidates({
      task: TASK, type: 'bugfix', repoDir: repo, runId: 'adv2', drivers, workspace, verify: true, adversarial: true,
      agents: [{ provider: 'claude' }, { provider: 'codex' }],
    });
    expect(record.adversarial!.tests).toEqual([expect.objectContaining({ id: 'anthropic-1', validity: 'vacuous' })]);
    expect(record.adversarial!.survival.codex).toEqual({ counted: 0, survived: 0, failed: [] });

    const single = await runCodeCandidates({
      task: TASK, repoDir: repo, runId: 'adv3', drivers, workspace, verify: true, adversarial: true, agents: [{ provider: 'claude' }],
    });
    expect(single.adversarial).toEqual({ skipped: 'fewer than 2 candidates', testCommand: null, adversaries: [], tests: [], matrix: {}, survival: {}, runs: [] });
    expect(git(repo, 'branch', '--list', 'concilium/adv3/adv-*')).toBe('');
  });
});

describe('runCodeCandidates ranking', () => {
  const SUM_TEST = "if (require('./sum.js')(1, 2) !== 3) throw new Error('1 + 2');\n";
  /** Lists the four feature playbook steps, so the report has no playbook finding. */
  const STEPS = '1. done\n2. done\n3. done\n4. skipped: no user surface';

  /** A repo whose only gate, `test`, passes on the base. */
  function seedTest(): string {
    writeFileSync(join(repo, 'sum.test.js'), SUM_TEST);
    mkdirSync(join(repo, '.concilium'));
    writeFileSync(join(repo, '.concilium', 'verify.yaml'), 'gates:\n  test: node sum.test.js\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'test gate');
    return git(repo, 'rev-parse', 'HEAD');
  }

  /**
   * A candidate that fails the framing run (so the rubric is the playbook's), changes files (null deletes) and ends
   * with `finalText`. With `judging`, it also answers a judge prompt as `judge` does.
   */
  function agent(id: string, files: Record<string, string | null>, finalText = STEPS, judging?: { prefer: string; prompts: string[] }): FakeCliDriver {
    return new FakeCliDriver({
      id,
      respond: (brief: Brief) => {
        if (judging && brief.mode === 'plan' && readFileSync(join(brief.cwd, COUNCIL_PROMPT_FILE), 'utf8').startsWith('You are judging')) {
          return score(brief, judging.prefer, judging.prompts);
        }
        if (brief.mode === 'plan') return [{ type: 'error', message: 'no framing' }];
        for (const [name, content] of Object.entries(files)) {
          if (content === null) rmSync(join(brief.cwd, name));
          else writeFileSync(join(brief.cwd, name), content);
        }
        return [{ type: 'text', text: finalText }];
      },
    });
  }

  /** A judge that scores every criterion 9 for the candidate whose section of the prompt holds `prefer`, 4 for the others. */
  function judge(id: string, prefer: string, prompts: string[]): FakeCliDriver {
    return new FakeCliDriver({ id, respond: (brief: Brief) => score(brief, prefer, prompts) });
  }

  function score(brief: Brief, prefer: string, prompts: string[]): RunEvent[] {
    const prompt = readFileSync(join(brief.cwd, COUNCIL_PROMPT_FILE), 'utf8');
    prompts.push(prompt);
    const scores = prompt.split('## Candidate ').slice(1).flatMap((section) => PLAYBOOKS.feature.rubric.map((c) => ({
      candidate: section[0], criterion: c.name, score: section.includes(prefer) ? 9 : 4, reason: `${c.name}: see the diff`,
    })));
    return [{ type: 'text', text: JSON.stringify({ scores }) }];
  }

  const NUMBER = 'module.exports = (a, b) => Number(a) + Number(b);\n';
  const UNARY = 'module.exports = (a, b) => +a + +b;\n';
  const TASK = 'make sum accept numeric strings';

  it('should rank a clear evidence winner without a judge and report each candidate with its SHAs and evidence', async () => {
    const baseSha = seedTest();
    const prompts: string[] = [];
    const drivers = new Map([
      ['claude', agent('claude', { 'sum.js': NUMBER })],
      ['codex', agent('codex', { 'sum.js': 'module.exports = (a, b) => a - b;\n' }, 'all done')],
      ['gemini', judge('gemini', NUMBER, prompts)],
      ['opencode', agent('opencode', {})],
    ]);
    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'rank1', drivers, workspace, verify: true, judge: true,
      agents: [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'opencode' }],
    });
    const [claude, codex, opencode] = record.candidates;

    expect(record.ranking.order.map((e) => [e.rank, e.candidateId, e.status])).toEqual([[1, 'claude', 'PASS'], [2, 'codex', 'ISSUES'], [3, 'opencode', 'BLOCKED']]);
    expect(record.ranking).toMatchObject({ winner: 'claude', reason: 'best on the evidence', judgments: [] });
    expect(prompts).toEqual([]);

    expect(claude.report).toEqual({
      status: 'PASS', branch: 'concilium/rank1/claude', baseSha, headSha: claude.headSha, reason: 'every check passed',
      evidence: [
        { kind: 'agent', ok: true, detail: 'the agent finished' },
        { kind: 'gate', ok: true, detail: 'test: pass', sha: claude.headSha },
        { kind: 'playbook', ok: true, detail: 'every playbook step listed as done or skipped' },
      ],
    });
    // The new gate failure, and the M3.1 check: steps the final message does not acknowledge are an issue.
    expect(codex.report).toMatchObject({ status: 'ISSUES', headSha: codex.headSha });
    expect(codex.report!.reason).toBe('test: fail, passes on the base; the final message does not list playbook step 1, 2, 3, 4 as done or skipped');
    expect(codex.report!.evidence).toContainEqual({ kind: 'gate', ok: false, detail: 'test: fail, passes on the base', sha: codex.headSha });
    expect(opencode.report).toMatchObject({ status: 'BLOCKED', reason: 'made no change' });
  });

  it('should send an exact tie to a judge of another family, blind, and let its scores order only the tie', async () => {
    seedTest();
    const prompts: string[] = [];
    const drivers = new Map([
      ['claude', agent('claude', { 'sum.js': NUMBER })],
      ['codex', agent('codex', { 'sum.js': UNARY })],
      ['gemini', judge('gemini', UNARY, prompts)],
    ]);
    const judged: string[] = [];
    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'rank2', drivers, workspace, verify: true, judge: true,
      agents: [{ provider: 'claude' }, { provider: 'codex' }],
      onJudgeDone: (j) => judged.push(`${j.judge} ${j.status}`),
    });

    expect(judged).toEqual(['gemini PASS']);
    const [judgment] = record.ranking.judgments;
    expect(judgment).toMatchObject({
      status: 'PASS', candidates: ['claude', 'codex'], judge: 'gemini', sameFamily: false, sameFamilyReason: null, rubricSha256: record.rubric.sha256,
      totals: { claude: 32, codex: 72 },
    });
    expect(record.candidates.flatMap((c) => c.report!.evidence).filter((e) => e.kind === 'judge')).toEqual([]);
    expect(judgment.scores).toContainEqual({ candidateId: 'codex', criterion: 'fit', score: 9, reason: 'fit: see the diff' });
    expect(record.ranking.order.map((e) => [e.rank, e.candidateId, e.judgeTotal])).toEqual([[1, 'codex', 72], [2, 'claude', 32]]);
    expect(record.ranking).toMatchObject({ winner: 'codex', reason: 'tied on the evidence, ordered by the judge' });

    // The judge ran read-only on the frozen rubric, the diffs and the evidence, and never learned who wrote what.
    const [run] = drivers.get('gemini')!.runs;
    expect(run.brief).toMatchObject({ mode: 'plan', allowedActions: ['read'] });
    expect(prompts[0]).toContain(record.rubric.sha256);
    expect(prompts[0]).toContain('+module.exports = (a, b) => +a + +b;');
    expect(prompts[0]).toContain('- ok, gate: test: pass');
    expect(prompts[0]).not.toMatch(/claude|codex|anthropic|openai/i);
  });

  it('should let a tied family judge only when no other family is usable, and flag it on the judgment and every tied report', async () => {
    seedTest();
    const prompts: string[] = [];
    // claude is a candidate and, as the only usable CLI besides codex, the judge.
    const drivers = new Map([
      ['claude', agent('claude', { 'sum.js': NUMBER }, STEPS, { prefer: UNARY, prompts })],
      ['codex', agent('codex', { 'sum.js': UNARY })],
    ]);
    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'rank5', drivers, workspace, verify: true, judge: true,
      agents: [{ provider: 'claude' }, { provider: 'codex' }],
    });

    const reason = 'no CLI outside the tied families (anthropic, openai) is usable, so claude judges';
    expect(record.ranking.judgments).toEqual([expect.objectContaining({ status: 'PASS', judge: 'claude', sameFamily: true, sameFamilyReason: reason })]);
    expect(prompts).toHaveLength(1);
    for (const c of record.candidates) {
      expect(c.report!.evidence).toContainEqual({ kind: 'judge', ok: true, detail: `same-family judge: ${reason}` });
    }
    expect(record.ranking).toMatchObject({ winner: 'codex', reason: 'tied on the evidence, ordered by the judge' });
  });

  it('should block the judge when the rubric no longer matches its frozen hash, and name no winner for the tie', async () => {
    seedTest();
    const prompts: string[] = [];
    const drivers = new Map([
      ['claude', agent('claude', { 'sum.js': NUMBER })],
      ['codex', agent('codex', { 'sum.js': UNARY })],
      ['gemini', judge('gemini', UNARY, prompts)],
    ]);
    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'rank3', drivers, workspace, verify: true, judge: true,
      agents: [{ provider: 'claude' }, { provider: 'codex' }],
      // The rubric changes after it was frozen.
      onFramed: (frame) => { frame.rubric.criteria[0].weight = 99; },
    });

    expect(record.ranking.judgments).toEqual([expect.objectContaining({ status: 'BLOCKED', judge: null, scores: [], totals: {} })]);
    expect(record.ranking.judgments[0].reason).toMatch(/^the rubric does not match its frozen sha256 [0-9a-f]{12} \(its criteria hash to [0-9a-f]{12}\)$/);
    expect(prompts).toEqual([]);
    expect(record.ranking.order.map((e) => [e.rank, e.candidateId])).toEqual([[1, 'claude'], [1, 'codex']]);
    expect(record.ranking.winner).toBeNull();
    expect(record.ranking.reason).toContain('no winner: claude, codex tie on the evidence and the judge is BLOCKED: the rubric does not match');
  });

  it('should name no winner when every candidate is disqualified', async () => {
    seedTest();
    const drivers = new Map([
      ['claude', agent('claude', { 'sum.js': NUMBER, 'sum.test.js': null })],
      ['codex', agent('codex', { 'sum.js': UNARY, 'sum.test.js': `const it = { skip: () => {} };\nit.skip('adds', () => {});\n${SUM_TEST}` })],
      ['gemini', judge('gemini', UNARY, [])],
    ]);
    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'rank4', drivers, workspace, verify: true, judge: true,
      agents: [{ provider: 'claude' }, { provider: 'codex' }],
    });

    expect(record.candidates.map((c) => c.verification!.disqualified)).toEqual([true, true]);
    expect(record.candidates.map((c) => c.report!.status)).toEqual(['ISSUES', 'ISSUES']);
    expect(record.candidates[0].report!.reason).toMatch(/^disqualified; .*deleted the test file sum\.test\.js/);
    expect(record.ranking).toMatchObject({ winner: null, reason: 'no winner: every candidate is blocked or disqualified', judgments: [] });
    expect(drivers.get('gemini')!.runs).toEqual([]);
  });
});
