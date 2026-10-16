/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAYBOOKS, TASK_TYPES } from '../domain/code-council/playbooks.js';
import { freezeRubric, rubricHash, type RubricCriterion } from '../domain/code-council/rubric.js';
import type { Brief } from '../domain/driver/brief.js';
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
  it.each(TASK_TYPES)('should hold the %s playbook steps and verification verbatim, and the frozen rubric', (type) => {
    const rubric = freezeRubric(PLAYBOOKS[type].rubric, { source: 'playbook' }, new Date('2026-10-16T12:00:00Z'));
    const brief = codeBrief('do the task', { taskType: { type, source: 'flag', reason: 'set with --type' }, rubric }, '/wt/claude', 'concilium/r/claude');

    for (const step of PLAYBOOKS[type].steps) expect(brief.task).toContain(step);
    for (const line of PLAYBOOKS[type].verification) expect(brief.task).toContain(line);
    for (const c of rubric.criteria) expect(brief.task).toContain(c.description);
    expect(brief.task).toContain(rubric.sha256);
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

  it('should freeze a rubric tailored by the first agent before any candidate starts, and give it to every candidate', async () => {
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
      expect(candidate.brief!.task).toContain(`sha256 ${record.rubric.sha256}`);
      expect(candidate.brief!.task).toContain('- repro (weight 3, evidence: gate): A test fails on empty input before the fix.');
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
    expect(rejected.candidates[0].brief!.task).toContain(`sha256 ${rubricHash(PLAYBOOKS.perf.rubric)}`);
  });

  it('should save the record under runs/<id>/run.json', async () => {
    const drivers = new Map([['claude', writer('claude', { 'x.txt': 'x\n' })]]);
    const record = await runCodeCandidates({ task: 't', repoDir: repo, agents: [{ provider: 'claude' }], runId: 'run5', drivers, workspace });
    const store = new JsonCodeRunStore(join(sandbox, `data-${counter}`));

    expect(await store.save(record)).toBe(join(sandbox, `data-${counter}`, 'runs', 'run5', 'run.json'));
    expect(await store.load('run5')).toEqual(record);
  });
});
