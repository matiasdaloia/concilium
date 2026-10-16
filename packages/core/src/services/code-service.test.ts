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
import { defaultCodeRoles, type CodeRoleMap } from '../domain/roles/roles.js';
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

describe('runCodeCandidates with adversarial', () => {
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

  it('should let the adversary role replace a family\'s default adversary and add one for a family with no candidate', async () => {
    seedSuite();
    const seen: Record<string, { cwd: string; patches: string[] }> = {};
    const sum = 'module.exports = (a, b) => a + b;\n';
    // Each adversary writes a regression guard, which counts for every candidate of another family.
    const adds = (a: number, b: number) => `if (require('./sum.js')(${a}, ${b}) !== ${a + b}) throw new Error('adds');\n`;
    const drivers = new Map([
      ['claude', agent('claude', sum, { 'a.test.js': adds(1, 1) }, seen)],
      ['codex', agent('codex', sum, { 'b.test.js': adds(2, 2) }, seen)],
      ['gemini', agent('gemini', sum, { 'c.test.js': adds(3, 3) }, seen)],
    ]);
    const record = await runCodeCandidates({
      task: TASK, repoDir: repo, runId: 'adv4', drivers, workspace, verify: true, adversarial: true,
      agents: [{ provider: 'claude' }, { provider: 'codex' }],
      roles: { ...defaultCodeRoles(['claude', 'codex']), adversary: { value: ['codex:gpt-5.2', 'gemini'], source: 'repo' } },
    });
    const round = record.adversarial!;
    expect(round.adversaries.map((a) => [a.lane, a.provider, a.model, a.peers])).toEqual([
      ['adv-anthropic', 'claude', null, ['codex']],
      ['adv-openai', 'codex', 'gpt-5.2', ['claude']],
      // Of no candidate's family, it attacks both, and its tests count against both.
      ['adv-google', 'gemini', null, ['claude', 'codex']],
    ]);
    expect(drivers.get('codex')!.runs.find((r) => r.brief.task.startsWith('You are an adversary'))!.opts.model).toBe('gpt-5.2');
    expect(drivers.get('gemini')!.runs.map((r) => r.brief.task.startsWith('You are an adversary'))).toEqual([true]);
    expect(round.survival.claude.counted).toBe(2);
    expect(round.survival.codex.counted).toBe(2);
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

  it('should use a configured judge and planner over the picked ones, flag a judge of a tied family, and record the role map', async () => {
    seedTest();
    const prompts: string[] = [];
    const geminiPrompts: string[] = [];
    // gemini, of another family, would be picked; the configured judge is claude on a set model.
    const drivers = new Map([
      ['claude', agent('claude', { 'sum.js': NUMBER }, STEPS, { prefer: UNARY, prompts })],
      ['codex', agent('codex', { 'sum.js': UNARY })],
      ['gemini', judge('gemini', UNARY, geminiPrompts)],
    ]);
    const roles: CodeRoleMap = {
      ...defaultCodeRoles(['claude', 'codex']),
      planner: { value: 'codex:gpt-5.2', source: 'saved' },
      judge: { value: 'claude:claude-opus-5-5', source: 'flag' },
    };
    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'rank7', drivers, workspace, verify: true, judge: true,
      agents: [{ provider: 'claude' }, { provider: 'codex' }], roles,
    });

    expect(record.roles).toEqual(roles);
    const reason = 'the configured judge claude:claude-opus-5-5 is of one of the families it reads (anthropic, openai)';
    expect(record.ranking.judgments).toEqual([expect.objectContaining({ status: 'PASS', judge: 'claude:claude-opus-5-5', sameFamily: true, sameFamilyReason: reason })]);
    for (const c of record.candidates) expect(c.report!.evidence).toContainEqual({ kind: 'judge', ok: true, detail: `same-family judge: ${reason}` });
    expect(geminiPrompts).toEqual([]);
    const judgeRun = drivers.get('claude')!.runs.find((r) => r.brief.mode === 'plan')!;
    expect(judgeRun.opts.model).toBe('claude-opus-5-5');
    // The planner, not the first agent, framed the rubric (its answer failed, so the playbook's stands).
    expect(record.rubric).toMatchObject({ source: 'playbook', framer: 'codex:gpt-5.2' });
    expect(drivers.get('codex')!.runs[0]).toMatchObject({ brief: { mode: 'plan' }, opts: { model: 'gpt-5.2' } });
  });

  it('should record the default role map when given only the agents', async () => {
    seedTest();
    const drivers = new Map([['claude', agent('claude', { 'sum.js': NUMBER })], ['codex', agent('codex', { 'sum.js': UNARY })]]);
    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'rank8', drivers, workspace, verify: false, judge: false,
      agents: [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'codex' }],
    });
    expect(record.roles).toEqual({
      planner: { value: 'claude:claude-opus-5-5', source: 'default' },
      implementer: { value: ['claude:claude-opus-5-5', 'codex'], source: 'default' },
      adversary: { value: 'same-as-implementer', source: 'default' },
      judge: { value: 'auto', source: 'default' },
      integrator: { value: 'winner', source: 'default' },
    });
  });

  it('should block the judge when the rubric no longer matches its frozen hash, and break the tie by the smallest diff', async () => {
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
    // Both change 2 lines in sum.js, so the candidate id decides.
    expect(record.ranking.order.map((e) => [e.rank, e.candidateId, e.size])).toEqual([[1, 'claude', { lines: 2, files: 1 }], [2, 'codex', { lines: 2, files: 1 }]]);
    expect(record.ranking.winner).toBe('claude');
    expect(record.ranking.reason).toMatch(/^tie broken by smallest diff: claude, codex tie on the evidence and the judge is BLOCKED: the rubric does not match .*; claude changes 2 lines in 1 file$/);
  });

  it('should give an unjudged tie to the candidate with the smallest diff', async () => {
    seedTest();
    const drivers = new Map([
      ['claude', agent('claude', { 'sum.js': NUMBER, 'notes.md': 'one\ntwo\n' })],
      ['codex', agent('codex', { 'sum.js': UNARY })],
    ]);
    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'rank6', drivers, workspace, verify: true, judge: false,
      agents: [{ provider: 'claude' }, { provider: 'codex' }],
    });
    expect(record.ranking.order.map((e) => [e.rank, e.candidateId, e.size])).toEqual([[1, 'codex', { lines: 2, files: 1 }], [2, 'claude', { lines: 4, files: 2 }]]);
    expect(record.ranking).toMatchObject({ winner: 'codex', judgments: [], reason: 'tie broken by smallest diff: claude, codex tie on the evidence and no judge ran; codex changes 2 lines in 1 file' });
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

describe('runCodeCandidates synthesis', () => {
  const STEPS = '1. done\n2. done\n3. done\n4. skipped: no user surface';
  const CLAUDE_SUM = 'module.exports = (a, b) => Number(a) + Number(b);\n';
  const STRINGS_TEST = "if (require('./sum.js')('2', '3') !== 5) throw new Error('strings');\n";
  const TASK = 'make sum accept numeric strings';

  /** A repo whose `test` gate runs every `*.test.js`, with one test that passes on the base. */
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
   * A fake CLI with a role per brief: candidate (writes `files`), adversary (writes `tests` and a manifest),
   * integrator (`integrate` maps a graft id to the files it writes). `seen` records each integrator brief.
   */
  function agent(id: string, files: Record<string, string>, opts: { tests?: Record<string, string>; integrate?: Record<string, Record<string, string>>; seen?: Brief[] } = {}): FakeCliDriver {
    return new FakeCliDriver({
      id,
      respond: (brief: Brief) => {
        if (brief.mode === 'plan') return [{ type: 'error', message: 'no framing' }];
        let write = files;
        if (brief.task.startsWith('You are an adversary')) {
          const tests = opts.tests ?? {};
          if (Object.keys(tests).length === 0) return [{ type: 'text', text: 'no tests' }];
          write = tests;
          writeFileSync(join(brief.cwd, 'concilium-adversarial.json'), JSON.stringify({ tests: Object.keys(tests).map((f) => ({ files: [f], specClause: 'sum adds' })) }));
        } else if (brief.task.startsWith('You are integrating')) {
          opts.seen?.push(brief);
          const graft = /^Graft (graft-\d+):/m.exec(brief.task)![1];
          write = opts.integrate?.[graft] ?? {};
        }
        for (const [name, content] of Object.entries(write)) writeFileSync(join(brief.cwd, name), content);
        return [{ type: 'text', text: STEPS }];
      },
    });
  }

  /** The read-only graft picker: answers a prompt that starts with `You are choosing grafts` with `grafts`. */
  function picker(id: string, grafts: object[], prompts: string[]): FakeCliDriver {
    return new FakeCliDriver({
      id,
      respond: (brief: Brief) => {
        const prompt = readFileSync(join(brief.cwd, COUNCIL_PROMPT_FILE), 'utf8');
        if (!prompt.startsWith('You are choosing grafts')) return [{ type: 'error', message: 'not a graft prompt' }];
        prompts.push(prompt);
        return [{ type: 'text', text: JSON.stringify({ grafts }) }];
      },
    });
  }

  it('should graft the losers\' ideas into the winner one commit each, revert a graft that breaks a test, and emit a patch that applies', async () => {
    const baseSha = seedSuite();
    const prompts: string[] = [];
    const seen: Brief[] = [];
    const drivers = new Map([
      // The winner, on the smallest diff, and the integrator: graft-1 adds codex's strings test, graft-2 (seeded) breaks sum.
      ['claude', agent('claude', { 'sum.js': CLAUDE_SUM }, {
        seen, integrate: { 'graft-1': { 'strings.test.js': STRINGS_TEST }, 'graft-2': { 'sum.js': 'module.exports = () => 0;\n' } },
      })],
      // Same fix plus a test, so a bigger diff; its adversary writes a regression guard that passes on the base.
      ['codex', agent('codex', { 'sum.js': 'module.exports = (a, b) => +a + +b;\n', 'strings.test.js': STRINGS_TEST }, {
        tests: { 'adds.test.js': "if (require('./sum.js')(2, 3) !== 5) throw new Error('2 + 3');\n" },
      })],
      // Makes no change: a dropout.
      ['opencode', agent('opencode', {})],
      ['gemini', picker('gemini', [
        { candidate: 'A', files: ['strings.test.js'], instruction: 'Add the numeric strings test.', why: 'The base has no test for the task.' },
        { candidate: 'A', files: ['sum.js'], hunk: '@@ -1 +1 @@', instruction: 'Use unary plus.', why: 'Shorter.' },
        { candidate: 'B', files: ['x.js'], instruction: 'Nothing.', why: 'None.' },
      ], prompts)],
    ]);
    const runDir = join(sandbox, `run-dir-${counter}`);
    const done: string[] = [];

    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'syn1', drivers, workspace, verify: true, adversarial: true, judge: false,
      agents: [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'opencode' }], synthesis: { runDir },
      onGraftDone: (g) => done.push(`${g.id} ${g.status}`),
    });
    const [claude] = record.candidates;
    const s = record.synthesis!;

    expect(record.ranking.winner).toBe('claude');
    expect(record.adversarial!.tests).toEqual([expect.objectContaining({ id: 'openai-1', validity: 'regression-guard' })]);
    expect(s).toMatchObject({
      base: { candidateId: 'claude', headSha: claude.headSha }, branch: 'concilium/syn1/integration',
      picker: { provider: 'gemini', sameFamily: false }, dropouts: [{ candidateId: 'opencode', reason: 'BLOCKED: made no change' }],
      notes: ['grafts[2] dropped: candidate must be one of A'],
    });
    expect(done).toEqual(['graft-1 applied', 'graft-2 rejected']);

    // The picker read the base and the loser blind; the dropout was not offered.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('## Base');
    expect(prompts[0]).toContain('## Candidate A');
    expect(prompts[0]).not.toContain('## Candidate B');
    expect(prompts[0]).not.toMatch(/claude|codex|opencode|anthropic|openai/i);
    expect(drivers.get('gemini')!.runs[0].brief).toMatchObject({ mode: 'plan', allowedActions: ['read'] });

    // A fresh integrator run per graft, in the integration worktree, with the source diff read-only.
    expect(seen.map((b) => b.cwd)).toEqual([s.worktree, s.worktree]);
    expect(seen[0].task).toContain('Instruction: Add the numeric strings test.');
    const source = seen[0].constraints.find((c) => c.startsWith('Source solution diff, read-only: '))!;
    expect(existsSync(source.slice(34))).toBe(false);

    const [applied, rejected] = s.grafts;
    expect(applied).toMatchObject({ id: 'graft-1', candidateId: 'codex', files: ['strings.test.js'], status: 'applied', revertSha: null, reason: '' });
    expect(git(repo, 'log', '-1', '--format=%an|%s', applied.commitSha!)).toBe('concilium|concilium: graft-1 from codex for run syn1');
    // graft-1 was checked at its own head: the gate and the valid adversarial test both pass there.
    expect(s.checks).toEqual({ sha: applied.commitSha, gates: { test: 'pass' }, tests: { 'openai-1': 'pass' } });

    expect(rejected).toMatchObject({ id: 'graft-2', candidateId: 'codex', hunk: '@@ -1 +1 @@', status: 'rejected' });
    expect(rejected.reason).toBe('gate test passed before the graft and is fail after it; adversarial test openai-1 (sum adds) passed before the graft and is error after it');
    expect(rejected.evidence[0]).toMatchObject({ kind: 'gate', sha: rejected.commitSha });
    expect(rejected.evidence[0].output).toContain('1 + 2');
    // Reverted on the branch: history keeps the graft and its revert, the tree is graft-1's.
    expect(git(repo, 'rev-list', '--reverse', `${claude.headSha}..${s.branch}`).split('\n')).toEqual([applied.commitSha, rejected.commitSha, rejected.revertSha]);
    expect(s.headSha).toBe(rejected.revertSha);
    expect(git(repo, 'show', `${s.branch}:sum.js`)).toBe(CLAUDE_SUM.trimEnd());
    expect(git(repo, 'show', `${s.branch}:strings.test.js`)).toBe(STRINGS_TEST.trimEnd());

    // The patch is the integration branch against the base, and it applies to the checkout's HEAD.
    expect(s.patchPath).toBe(join(runDir, 'result.patch'));
    const patch = readFileSync(s.patchPath!, 'utf8');
    expect(patch).toBe(`${git(repo, 'diff', '--binary', baseSha, s.branch!)}\n`);
    expect(s).toMatchObject({ mergeable: true, mergeCheck: { applies: true, targetSha: baseSha } });
    git(repo, 'apply', '--check', s.patchPath!);

    const md = readFileSync(join(runDir, 'synthesis.md'), 'utf8');
    expect(s.synthesisPath).toBe(join(runDir, 'synthesis.md'));
    expect(md).toContain(`\`claude\` at \`${claude.headSha}\``);
    expect(md).toContain('- **graft-1** from `codex` (`strings.test.js`): Add the numeric strings test.');
    expect(md).toContain('- **graft-2** from `codex` (`sum.js`, hunk `@@ -1 +1 @@`): Use unary plus.');
    expect(md).toContain(`reverted by \`${rejected.revertSha}\``);
    expect(md).toContain('- `opencode`: BLOCKED: made no change');
    expect(md).toContain('- Mergeable: yes');

    // The rejected graft is dissent overruled by the checks that failed after it; nothing is open, so the label stays.
    expect(record.dissent).toEqual({ path: join(runDir, 'dissent.json'), records: [expect.objectContaining({ id: 'dissent-1', source: 'rejected-graft', resolution: 'overruled' })] });
    const [graftDissent] = record.dissent.records;
    expect(graftDissent.resolutionReason).toBe(`${rejected.evidence.map((e) => `${e.detail}${e.sha ? ` at ${e.sha}` : ''}`).join('; ')}; reverted by ${rejected.revertSha}`);
    expect(graftDissent.evidence).toContainEqual({ kind: 'commit', ref: 'graft-2', sha: rejected.commitSha });
    expect(JSON.parse(readFileSync(join(runDir, 'dissent.json'), 'utf8'))).toEqual({ version: 1, runId: 'syn1', records: record.dissent.records });
    expect(md).toMatch(/^# Synthesis of run syn1\n\nTask: .*\n\n## Dissent\n\n0 open of 1, also in `dissent.json`.\n\n- \*\*dissent-1\*\* overruled, rejected-graft: graft-2 from codex/);
    expect(md.indexOf('## Dissent')).toBeLessThan(md.indexOf('## Base'));

    // The checkout is untouched; gc keeps the integration branch.
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const gc = await workspace.gc({ runId: 'syn1', dryRun: true });
    expect(gc[0].keptBranches).toEqual(['concilium/syn1/integration']);
    // No divergence: the run is done and asks nothing.
    expect(record.status).toBe('done');
    expect(record.reframe).toBeUndefined();
    expect(existsSync(join(runDir, 'reframe.md'))).toBe(false);
  }, 60_000);

  it('should let the configured judge name the grafts and the configured integrator fold them in', async () => {
    seedSuite();
    const prompts: string[] = [];
    const seen: Brief[] = [];
    const graft = { candidate: 'A', files: ['strings.test.js'], instruction: 'Add the numeric strings test.', why: 'The base has no test for the task.' };
    const drivers = new Map([
      ['claude', agent('claude', { 'sum.js': CLAUDE_SUM })],
      // A bigger diff, and the configured judge: it names the grafts on a set model.
      ['codex', new FakeCliDriver({
        id: 'codex',
        respond: (brief: Brief) => {
          if (brief.mode === 'plan') {
            const prompt = readFileSync(join(brief.cwd, COUNCIL_PROMPT_FILE), 'utf8');
            if (!prompt.startsWith('You are choosing grafts')) return [{ type: 'error', message: 'no framing' }];
            prompts.push(prompt);
            return [{ type: 'text', text: JSON.stringify({ grafts: [graft] }) }];
          }
          writeFileSync(join(brief.cwd, 'sum.js'), 'module.exports = (a, b) => +a + +b;\n');
          writeFileSync(join(brief.cwd, 'strings.test.js'), STRINGS_TEST);
          return [{ type: 'text', text: STEPS }];
        },
      })],
      // No candidate: only the configured integrator.
      ['gemini', agent('gemini', {}, { seen, integrate: { 'graft-1': { 'strings.test.js': STRINGS_TEST } } })],
    ]);
    const runDir = join(sandbox, `run-dir-${counter}`);
    const roles: CodeRoleMap = {
      ...defaultCodeRoles(['claude', 'codex']),
      judge: { value: 'codex:gpt-5.2', source: 'repo' },
      integrator: { value: 'gemini:gemini-3-pro', source: 'flag' },
    };
    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'syn4', drivers, workspace, verify: true, judge: false,
      agents: [{ provider: 'claude' }, { provider: 'codex' }], roles, synthesis: { runDir },
    });
    const s = record.synthesis!;

    expect(s.base?.candidateId).toBe('claude');
    expect(s.picker).toEqual({
      provider: 'codex:gpt-5.2', sameFamily: true, sameFamilyReason: 'the configured judge codex:gpt-5.2 is of one of the families it reads (anthropic, openai)',
    });
    expect(prompts).toHaveLength(1);
    expect(drivers.get('codex')!.runs.find((r) => r.brief.mode === 'plan')!.opts.model).toBe('gpt-5.2');
    expect(s.grafts).toEqual([expect.objectContaining({ id: 'graft-1', status: 'applied', integrator: expect.objectContaining({ provider: 'gemini', model: 'gemini-3-pro', status: 'ok' }) })]);
    expect(seen.map((b) => b.cwd)).toEqual([s.worktree]);
    expect(drivers.get('gemini')!.runs[0].opts.model).toBe('gemini-3-pro');
    expect(drivers.get('claude')!.runs.some((r) => r.brief.task.startsWith('You are integrating'))).toBe(false);
    expect(git(repo, 'show', `${s.branch}:strings.test.js`)).toBe(STRINGS_TEST.trimEnd());
    expect(record.roles).toEqual(roles);
  }, 60_000);

  it('should keep the patch but not label it mergeable while dissent on an acceptance line is open', async () => {
    seedSuite();
    const drivers = new Map([
      ['claude', agent('claude', { 'sum.js': CLAUDE_SUM })],
      // Its adversary writes a test nothing can pass: quarantined, and no judge has classified it.
      ['codex', agent('codex', { 'sum.js': 'module.exports = (a, b) => +a + +b;\n', 'strings.test.js': STRINGS_TEST }, {
        tests: { 'never.test.js': "throw new Error('never');\n" },
      })],
      ['gemini', picker('gemini', [], [])],
    ]);
    const runDir = join(sandbox, `run-dir-${counter}`);
    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'syn5', drivers, workspace, verify: true, adversarial: true, judge: false,
      agents: [{ provider: 'claude' }, { provider: 'codex' }], synthesis: { runDir },
    });
    const s = record.synthesis!;

    expect(record.adversarial!.tests).toEqual([expect.objectContaining({ id: 'openai-1', validity: 'quarantined', specClause: 'sum adds' })]);
    expect(record.status).toBe('done');
    expect(record.dissent.records).toEqual([expect.objectContaining({
      id: 'dissent-1', source: 'quarantined-test', acceptanceClause: 'sum adds', resolution: 'open', resolutionReason: null,
      evidence: [{ kind: 'test', ref: 'openai-1' }, { kind: 'file', ref: 'never.test.js' }],
    })]);
    // The patch is written and applies, but open dissent on "sum adds" takes the label away.
    expect(s.mergeCheck).toMatchObject({ applies: true });
    expect(s).toMatchObject({ mergeable: false, mergeBlock: 'open dissent on acceptance lines: dissent-1 ("sum adds")', patchPath: join(runDir, 'result.patch') });
    const md = readFileSync(join(runDir, 'synthesis.md'), 'utf8');
    expect(md).toContain('1 open of 1, also in `dissent.json`. Open dissent on an acceptance line (dissent-1) keeps the patch from being labelled mergeable.');
    expect(md).toContain('- Mergeable: no, open dissent on acceptance lines: dissent-1 ("sum adds"); `git apply --check`');
    expect(JSON.parse(readFileSync(join(runDir, 'dissent.json'), 'utf8')).records).toEqual(record.dissent.records);
  }, 60_000);

  it('should skip synthesis with fewer than 2 candidates, without a winner, and without the gates', async () => {
    seedSuite();
    const drivers = new Map([
      ['claude', agent('claude', { 'sum.js': CLAUDE_SUM })],
      ['codex', agent('codex', { 'sum.test.js': "const it = { skip: () => {} };\nit.skip('adds', () => {});\n" })],
    ]);
    const runDir = join(sandbox, `run-dir-${counter}`);
    const run = (runId: string, agents: { provider: string }[], verify = true) =>
      runCodeCandidates({ task: TASK, type: 'feature', repoDir: repo, runId, drivers, workspace, verify, agents, synthesis: { runDir } });

    expect((await run('syn2', [{ provider: 'claude' }])).synthesis).toMatchObject({ skipped: 'fewer than 2 candidates', branch: null, patchPath: null, mergeable: false });
    // codex skips the test: disqualified, so two of it leave no winner.
    expect((await run('syn3', [{ provider: 'codex' }, { provider: 'codex' }])).synthesis).toMatchObject({ skipped: 'no winner' });
    expect((await run('syn4', [{ provider: 'claude' }, { provider: 'codex' }], false)).synthesis).toMatchObject({ skipped: 'the gates did not run, so no graft could be re-verified' });
    expect(git(repo, 'branch', '--list', 'concilium/*/integration')).toBe('');
    expect(existsSync(runDir)).toBe(false);
  });
});

describe('runCodeCandidates reframe', () => {
  const LINE = "slugify('Hello World') joins the words with a separator";
  const TASK = `Add slugify(text) in slug.js.\nAcceptance:\n- ${LINE}`;
  const STEPS = '1. done\n2. done\n3. done\n4. skipped: no user surface';
  const slug = (sep: string) => `module.exports = (s) => s.toLowerCase().split(' ').join('${sep}');\n`;
  const expects = (out: string) => `if (require('./slug.js')('Hello World') !== '${out}') throw new Error('not ${out}');\n`;

  /** A repo whose `test` gate runs every `*.test.js`, with one test that passes on the base. */
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
   * One reading of LINE, joining with `sep`: as a candidate it writes slug.js, as an adversary a test for its own
   * reading quoting LINE. Asked for questions (a plan brief whose prompt starts `You are phrasing spec questions`),
   * it answers `questions`, or fails when there are none; it fails the framing run.
   */
  function reading(id: string, sep: string, questions: object[] = [], prompts: string[] = []): FakeCliDriver {
    return new FakeCliDriver({
      id,
      respond: (brief: Brief) => {
        if (brief.mode === 'plan') {
          const prompt = readFileSync(join(brief.cwd, COUNCIL_PROMPT_FILE), 'utf8');
          if (!prompt.startsWith('You are phrasing spec questions') || questions.length === 0) return [{ type: 'error', message: 'no answer' }];
          prompts.push(prompt);
          return [{ type: 'text', text: JSON.stringify({ questions }) }];
        }
        if (brief.task.startsWith('You are an adversary')) {
          writeFileSync(join(brief.cwd, `${id}-reading.test.js`), expects(`hello${sep}world`));
          writeFileSync(join(brief.cwd, 'concilium-adversarial.json'), JSON.stringify({ tests: [{ files: [`${id}-reading.test.js`], specClause: LINE }] }));
          return [{ type: 'text', text: 'wrote a test' }];
        }
        writeFileSync(join(brief.cwd, 'slug.js'), slug(sep));
        return [{ type: 'text', text: STEPS }];
      },
    });
  }

  it('should end an ambiguous task in reframe-needed, name the line read two ways, and write no patch', async () => {
    const baseSha = seedSuite();
    const prompts: string[] = [];
    const drivers = new Map([
      ['claude', reading('claude', '-', [{ clause: LINE, question: 'Should the separator be a hyphen or an underscore?' }, { clause: 'other', question: '?' }], prompts)],
      ['codex', reading('codex', '_')],
    ]);
    const runDir = join(sandbox, `run-dir-${counter}`);
    const record = await runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId: 'ref1', drivers, workspace, verify: true, adversarial: true, judge: false,
      agents: [{ provider: 'claude' }, { provider: 'codex' }], synthesis: { runDir },
    });

    // Both pass the gates; each fails the other family's reading of the same line, so neither dominates.
    expect(record.candidates.map((c) => c.verification!.status)).toEqual(['PASS', 'PASS']);
    expect(record.adversarial!.matrix).toEqual({
      'anthropic-1': { base: 'fail', claude: 'pass', codex: 'fail' },
      'openai-1': { base: 'fail', claude: 'fail', codex: 'pass' },
    });
    expect(record.status).toBe('reframe-needed');
    const reframe = record.reframe!;
    expect(reframe.divergence).toEqual([{
      trigger: 'disjoint-survival',
      detail: 'each candidate that passes the gates fails different adversarial tests: claude fails openai-1; codex fails anthropic-1',
      conflicts: [{ clause: LINE, evidence: ['claude passes anthropic-1, fails openai-1', 'codex passes openai-1, fails anthropic-1'] }],
      tests: ['openai-1', 'anthropic-1'],
    }]);
    // The framer's CLI phrased the question read-only, from the evidence and both diffs.
    expect(reframe).toMatchObject({
      phraser: 'claude', source: 'phraser', notes: ['questions[1] dropped: names no line in conflict'],
      questions: [{ clause: LINE, question: 'Should the separator be a hyphen or an underscore?' }],
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`- clause: ${LINE}`);
    expect(prompts[0]).toContain("+module.exports = (s) => s.toLowerCase().split(' ').join('_');");
    expect(drivers.get('claude')!.runs.filter((r) => r.brief.mode === 'plan').at(-1)!.brief).toMatchObject({ allowedActions: ['read'] });

    // Grafting was tried first: the integration branch is kept for inspection, but the conflict is still there, so no patch.
    const s = record.synthesis!;
    expect(s.skipped).toBeUndefined();
    expect(s).toMatchObject({ base: { candidateId: 'claude' }, branch: 'concilium/ref1/integration', patchPath: null, mergeable: false, mergeCheck: null });
    expect(s.divergence).toEqual({ tests: ['openai-1', 'anthropic-1'], resolved: false, reason: 'at the integration head openai-1 is fail' });
    expect(s.checks).toMatchObject({ sha: s.headSha, gates: { test: 'pass' }, tests: { 'anthropic-1': 'pass', 'openai-1': 'fail' } });
    expect(git(repo, 'rev-parse', 'concilium/ref1/integration')).toBe(s.headSha);
    expect(existsSync(join(runDir, 'result.patch'))).toBe(false);
    expect(reframe.grafting).toEqual({
      branch: 'concilium/ref1/integration', headSha: s.headSha, applied: 0, rejected: 0,
      outcome: 'at the integration head openai-1 is fail', synthesisPath: join(runDir, 'synthesis.md'),
    });
    expect(readFileSync(join(runDir, 'synthesis.md'), 'utf8')).toContain('Not resolved: at the integration head openai-1 is fail. No patch was kept');
    expect(reframe.reportPath).toBe(join(runDir, 'reframe.md'));
    const md = readFileSync(reframe.reportPath!, 'utf8');
    expect(md).toContain(`1. On "${LINE}": Should the separator be a hyphen or an underscore?`);
    expect(md).toContain('## Grafting\n\nGrafting was tried first on `concilium/ref1/integration`');
    expect(md).toContain(baseSha.slice(0, 12));
    // The conflicting test the integration head still fails is open dissent on the line, at the top of both reports.
    // Only claude and codex are installed, so claude names the grafts: a same-family picker, an accepted risk.
    expect(record.dissent.records).toEqual([
      expect.objectContaining({
        source: 'adversarial-test', acceptanceClause: LINE, resolution: 'open', evidence: expect.arrayContaining([{ kind: 'commit', ref: 'concilium/ref1/integration', sha: s.headSha }]),
      }),
      expect.objectContaining({ source: 'same-family-judge', resolution: 'accepted-risk', resolutionReason: s.picker!.sameFamilyReason }),
    ]);
    expect(s.mergeBlock).toBe(`open dissent on acceptance lines: dissent-1 ("${LINE}")`);
    expect(md.indexOf('## Dissent')).toBeGreaterThan(0);
    expect(md.indexOf('## Dissent')).toBeLessThan(md.indexOf('## Divergence'));
    expect(md).toContain('**dissent-1** open, adversarial-test: the integration head is fail on adversarial test openai-1 by openai.');
    expect(readFileSync(join(runDir, 'synthesis.md'), 'utf8')).toContain('**dissent-1** open, adversarial-test');
    expect(existsSync(join(runDir, 'dissent.json'))).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  }, 60_000);

  it('should graft complementary misses into the winner and finish done when the integration passes every conflicting test', async () => {
    const LOWER = 'slugify lowercases the text';
    const TRIM = 'slugify trims the text';
    const task = `Add slugify(text) in slug.js.\nAcceptance:\n- ${LOWER}\n- ${TRIM}`;
    seedSuite();
    /** A candidate that writes `code`; as an adversary it writes one test with `clause`; as the integrator it writes `integrated`. */
    const half = (id: string, code: string, test: string, clause: string): FakeCliDriver => new FakeCliDriver({
      id,
      respond: (brief: Brief) => {
        if (brief.mode === 'plan') return [{ type: 'error', message: 'no answer' }];
        if (brief.task.startsWith('You are an adversary')) {
          writeFileSync(join(brief.cwd, `${id}.test.js`), test);
          writeFileSync(join(brief.cwd, 'concilium-adversarial.json'), JSON.stringify({ tests: [{ files: [`${id}.test.js`], specClause: clause }] }));
          return [{ type: 'text', text: 'wrote a test' }];
        }
        writeFileSync(join(brief.cwd, 'slug.js'), brief.task.startsWith('You are integrating') ? 'module.exports = (s) => s.trim().toLowerCase();\n' : code);
        return [{ type: 'text', text: STEPS }];
      },
    });
    const prompts: string[] = [];
    const drivers = new Map([
      // claude lowercases but does not trim, and tests the lowercasing; codex trims but does not lowercase, and tests the trimming.
      ['claude', half('claude', 'module.exports = (s) => s.toLowerCase();\n', "if (require('./slug.js')('AB') !== 'ab') throw new Error('lower');\n", LOWER)],
      ['codex', half('codex', 'module.exports = (s) => s.trim();\n', "if (require('./slug.js')(' ab ') !== 'ab') throw new Error('trim');\n", TRIM)],
      ['gemini', new FakeCliDriver({
        id: 'gemini',
        respond: (brief: Brief) => {
          const prompt = readFileSync(join(brief.cwd, COUNCIL_PROMPT_FILE), 'utf8');
          if (!prompt.startsWith('You are choosing grafts')) return [{ type: 'error', message: 'not a graft prompt' }];
          prompts.push(prompt);
          return [{ type: 'text', text: JSON.stringify({ grafts: [{ candidate: 'A', files: ['slug.js'], instruction: 'Trim the text too.', why: 'The base keeps the spaces.' }] }) }];
        },
      })],
    ]);
    const runDir = join(sandbox, `run-dir-${counter}`);
    const record = await runCodeCandidates({
      task, type: 'feature', repoDir: repo, runId: 'ref4', drivers, workspace, verify: true, adversarial: true, judge: false,
      agents: [{ provider: 'claude' }, { provider: 'codex' }], synthesis: { runDir },
    });

    // Each misses the line the other covers: a disjoint-survival divergence on two lines.
    expect(record.adversarial!.matrix).toEqual({
      'anthropic-1': { base: 'fail', claude: 'pass', codex: 'fail' },
      'openai-1': { base: 'fail', claude: 'fail', codex: 'pass' },
    });
    const s = record.synthesis!;
    expect(prompts).toHaveLength(1);
    expect(s.grafts).toEqual([expect.objectContaining({ id: 'graft-1', candidateId: 'codex', status: 'applied' })]);
    // Re-run at the integration head: the gates and both conflicting tests pass, so the run is done with a patch.
    expect(s.divergence).toEqual({ tests: ['openai-1', 'anthropic-1'], resolved: true, reason: 'the integration head passes the gates and every conflicting test (openai-1, anthropic-1)' });
    expect(s.checks).toEqual({ sha: s.headSha, gates: { test: 'pass' }, tests: { 'anthropic-1': 'pass', 'openai-1': 'pass' } });
    expect(record.status).toBe('done');
    expect(record.reframe).toBeUndefined();
    expect(existsSync(join(runDir, 'reframe.md'))).toBe(false);
    expect(s.patchPath).toBe(join(runDir, 'result.patch'));
    expect(s.mergeable).toBe(true);
    git(repo, 'apply', '--check', s.patchPath!);
    expect(git(repo, 'show', `${s.branch}:slug.js`)).toBe('module.exports = (s) => s.trim().toLowerCase();');
    const md = readFileSync(join(runDir, 'synthesis.md'), 'utf8');
    expect(md).toContain('## Divergence\n\nThe candidates diverged (disjoint-survival on openai-1, anthropic-1), so grafting was tried before a reframe.');
    expect(md).toContain('Resolved: the integration head passes the gates and every conflicting test (openai-1, anthropic-1).');
  }, 60_000);

  it('should write the questions from the evidence when the phraser gives no answer, and skip the check without synthesis', async () => {
    seedSuite();
    const drivers = new Map([['claude', reading('claude', '-')], ['codex', reading('codex', '_')]]);
    const runDir = join(sandbox, `run-dir-${counter}`);
    const run = (runId: string, synthesis?: { runDir: string }) => runCodeCandidates({
      task: TASK, type: 'feature', repoDir: repo, runId, drivers, workspace, verify: true, adversarial: true, judge: false,
      agents: [{ provider: 'claude' }, { provider: 'codex' }], synthesis,
    });

    const record = await run('ref2', { runDir });
    expect(record.status).toBe('reframe-needed');
    expect(record.reframe).toMatchObject({ phraser: 'claude', source: 'fallback', notes: ['claude gave no answer, so the questions were written from the evidence'] });
    expect(record.reframe!.questions).toEqual([{
      clause: LINE,
      question: `The candidates read "${LINE}" differently (claude passes anthropic-1, fails openai-1; codex passes openai-1, fails anthropic-1). Which reading is intended? Restate the line so only one reading is left.`,
    }]);
    expect(readFileSync(join(runDir, 'reframe.md'), 'utf8')).toContain('Written from the evidence');

    // Without synthesis there is no blend to stop: the run is done.
    const plain = await run('ref3');
    expect(plain.status).toBe('done');
    expect(plain.reframe).toBeUndefined();
  }, 60_000);
});
