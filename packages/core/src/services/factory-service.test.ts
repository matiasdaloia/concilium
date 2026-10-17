/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskListValidationError } from '../domain/code-council/factory.js';
import type { Brief } from '../domain/driver/brief.js';
import { COUNCIL_PROMPT_FILE } from '../adapters/cli/cli-council-gateway.js';
import { FakeCliDriver } from '../adapters/cli/fake-cli-driver.js';
import { GitWorktreeWorkspace } from '../adapters/git-worktree-workspace.js';
import { JsonCodeRunStore } from '../adapters/json-code-run-store.js';
import { setLogLevel } from '../shared/logger.js';
import { loadFactory, runFactory, type FactoryInput } from './factory-service.js';

const sandbox = mkdtempSync(join(tmpdir(), 'concilium-factory-test-'));
const gitConfig = join(sandbox, 'gitconfig');
let repo: string;
let store: JsonCodeRunStore;
let workspace: GitWorktreeWorkspace;
let counter = 0;

const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[name];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trimEnd();
}

const RUN_TESTS = "for (const f of require('fs').readdirSync('.').filter((f) => f.endsWith('.test.js'))) require('./' + f);\n";
const STEPS = '1. done\n2. done\n3. done\n4. skipped: no user surface';

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

/** A repo whose `test` gate runs every `*.test.js`. */
beforeEach(() => {
  counter += 1;
  repo = join(sandbox, `repo-${counter}`);
  mkdirSync(join(repo, '.concilium'), { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'run-tests.js'), RUN_TESTS);
  writeFileSync(join(repo, '.concilium', 'verify.yaml'), 'gates:\n  test: node run-tests.js\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  store = new JsonCodeRunStore(join(sandbox, `data-${counter}`));
  workspace = new GitWorktreeWorkspace({ root: join(sandbox, `worktrees-${counter}`) });
});

const MUL = { id: 'mul', title: 'Add mul.js exporting a multiply function', type: 'feature', acceptance: ['mul(2, 3) is 6'], depends_on: [] };
const SQUARE = { id: 'square', title: 'Add square.js built on mul.js', type: 'feature', acceptance: ['square(4) is 16', 'square uses mul'], depends_on: ['mul'] };

/**
 * What each candidate writes per task: `square.test.js` passes only where `mul.js` exists, so only on a stacked base.
 * Codex's diffs are larger, so claude wins each task on the smallest diff and codex, another family, verifies.
 */
const WRITES: Record<string, Record<string, Record<string, string>>> = {
  claude: {
    mul: { 'mul.js': 'module.exports = (a, b) => a * b;\n', 'mul.test.js': "if (require('./mul.js')(2, 3) !== 6) throw new Error('mul');\n" },
    square: { 'square.js': "const mul = require('./mul.js');\nmodule.exports = (x) => mul(x, x);\n", 'square.test.js': "if (require('./square.js')(4) !== 16) throw new Error('square');\n" },
  },
  codex: {
    mul: { 'mul.js': '// multiply two numbers\n// codex\nmodule.exports = (a, b) => a * b;\n' },
    square: { 'square.js': '// square a number\n// without mul\n// codex\nmodule.exports = (x) => x * x;\n' },
  },
};

/**
 * A fake CLI per role, keyed by the prompt or brief it gets: the planner answers `You are planning` with `plan`, a
 * reviewer answers `You are reviewing a change` with a PASS, a graft picker names no graft; a candidate writes its
 * files for the task named in its brief. Every brief is recorded in `seen`.
 */
function agent(id: string, opts: { plan?: object; fail?: boolean; seen?: Brief[] } = {}): FakeCliDriver {
  return new FakeCliDriver({
    id,
    respond: (brief: Brief) => {
      opts.seen?.push(brief);
      if (brief.mode === 'plan') {
        const prompt = readFileSync(join(brief.cwd, COUNCIL_PROMPT_FILE), 'utf8');
        if (prompt.startsWith('You are planning') && opts.plan) return [{ type: 'text', text: JSON.stringify(opts.plan) }];
        if (prompt.startsWith('You are reviewing a change')) return [{ type: 'text', text: 'VERDICT: PASS\nThe change does what the task asks.' }];
        if (prompt.startsWith('You are choosing grafts')) return [{ type: 'text', text: '{"grafts": []}' }];
        return [{ type: 'error', message: 'not my prompt' }];
      }
      if (opts.fail) return [{ type: 'error', message: `${id} crashed` }];
      const task = brief.task.startsWith(SQUARE.title) ? 'square' : 'mul';
      for (const [name, content] of Object.entries(WRITES[id][task])) writeFileSync(join(brief.cwd, name), content);
      return [{ type: 'text', text: STEPS }];
    },
  });
}

function input(drivers: Map<string, FakeCliDriver>, over: Partial<FactoryInput> = {}): FactoryInput {
  return {
    spec: '# Math\nAdd multiply, then square on top of it.\n',
    specPath: 'spec.md',
    repoDir: repo,
    planner: 'claude',
    code: { agents: [{ provider: 'claude' }, { provider: 'codex' }], drivers, workspace, adversarial: false, judge: false },
    runDir: (id) => store.runDir(id),
    saveRun: (record) => store.save(record),
    ...over,
  };
}

describe('runFactory', () => {
  it('should run a two-task spec as two stacked integration branches, each verified at its own head', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const claudeBriefs: Brief[] = [];
    const codexBriefs: Brief[] = [];
    const drivers = new Map([
      // Listed out of order: square depends on mul, so mul runs first.
      ['claude', agent('claude', { plan: { tasks: [SQUARE, MUL] }, seen: claudeBriefs })],
      ['codex', agent('codex', { seen: codexBriefs })],
      ['gemini', agent('gemini')],
    ]);
    const started: string[] = [];

    const record = await runFactory(input(drivers, { factoryId: 'f1', onTaskStart: (t, runId, base) => started.push(`${t.id} ${runId} ${base}`) }));

    expect(record).toMatchObject({ id: 'f1', kind: 'factory', status: 'done', stoppedAt: null, baseSha: head, planner: 'claude', specPath: 'spec.md' });
    expect(record.specSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.tasks.map((t) => t.id)).toEqual(['mul', 'square']);
    const [first, second] = record.steps;
    if (first.outcome !== 'shipped' || second.outcome !== 'shipped') throw new Error(`not shipped: ${JSON.stringify(record.steps)}`);

    // Stacked: the first starts from HEAD, the second from the commit the first shipped.
    expect(first.baseSha).toBe(head);
    expect(second.baseSha).toBe(first.headSha);
    expect(started).toEqual([`mul ${first.runId} ${head}`, `square ${second.runId} ${first.headSha}`]);
    expect(first.branch).toBe(`concilium/${first.runId}/integration`);
    expect(second.branch).toBe(`concilium/${second.runId}/integration`);
    git(repo, 'merge-base', '--is-ancestor', first.headSha, second.headSha);
    expect(git(repo, 'show', `${second.headSha}:mul.js`)).toBe('module.exports = (a, b) => a * b;');

    // Each verified at its own head: the integration head without the trail commit on top, by a family that wrote none of it.
    for (const step of [first, second]) {
      const run = await store.load(step.runId);
      expect(run.status).toBe('done');
      expect(run.prVerdict).toMatchObject({ verdict: 'PASS', headSha: step.headSha, branch: step.branch, gates: { test: 'pass' }, verifier: { provider: 'codex', sameFamily: false } });
      expect(step.headSha).toBe(git(repo, 'rev-parse', `${step.branch}~1`));
      expect(step.headSha).toBe(run.synthesis!.headSha);
      expect(run.baseSha).toBe(step.baseSha);
      expect(existsSync(join(store.runDir(step.runId), 'verification.md'))).toBe(true);
    }
    expect(first).toMatchObject({ verdict: 'PASS', sameFamily: false });

    // Each candidate brief holds its task's acceptance lines.
    const candidateTasks = claudeBriefs.filter((b) => b.mode === 'code').map((b) => b.task);
    expect(candidateTasks[0]).toContain('Add mul.js exporting a multiply function\n\nAcceptance (each line must hold when you finish):\n- mul(2, 3) is 6');
    expect(candidateTasks[1]).toContain('- square(4) is 16\n- square uses mul');
    expect(codexBriefs.filter((b) => b.mode === 'code')).toHaveLength(2);

    // tasks.json, tasks.md and factory.json in the factory's run dir.
    const dir = store.runDir('f1');
    expect(JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'))).toMatchObject({ version: 1, specSha256: record.specSha256, tasks: record.tasks });
    expect(readFileSync(join(dir, 'tasks.md'), 'utf8')).toContain('## 2. square: Add square.js built on mul.js');
    expect(await loadFactory(dir)).toEqual(record);

    // Nothing touched the checkout or pushed anything.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'remote')).toBe('');
  });

  it('should stop the chain at the first task without a shippable head and leave the rest not run', async () => {
    const drivers = new Map([
      ['claude', agent('claude', { plan: { tasks: [MUL, SQUARE] }, fail: true })],
      ['codex', agent('codex', { fail: true })],
      ['gemini', agent('gemini')],
    ]);

    const record = await runFactory(input(drivers));

    expect(record).toMatchObject({ status: 'stopped', stoppedAt: 'mul' });
    expect(record.steps).toEqual([
      expect.objectContaining({ taskId: 'mul', outcome: 'stopped', reason: 'every candidate failed', runStatus: 'done', verdict: null }),
      { taskId: 'square', outcome: 'not-run', reason: 'task mul stopped the chain' },
    ]);
    // The stopped task's run is saved for inspection; no run was started for the second.
    const stopped = record.steps[0];
    if (stopped.outcome !== 'stopped') throw new Error('not stopped');
    expect((await store.load(stopped.runId)).prVerdict).toBeUndefined();
    expect(drivers.get('claude')!.runs.filter((r) => r.brief.mode === 'code')).toHaveLength(1);
  });

  it('should reject an invalid task list before any run, naming every problem', async () => {
    const drivers = new Map([['claude', agent('claude', { plan: { tasks: [{ ...MUL, acceptance: [] }, { ...SQUARE, depends_on: ['ghost'] }] } })]]);

    const run = runFactory(input(drivers, { factoryId: 'f-bad' }));

    await expect(run).rejects.toBeInstanceOf(TaskListValidationError);
    await expect(run).rejects.toThrow('tasks[0].acceptance: at least one line is required; tasks[1].depends_on: unknown task "ghost"');
    expect(existsSync(join(store.runDir('f-bad'), 'tasks.json'))).toBe(false);
    expect(drivers.get('claude')!.runs.filter((r) => r.brief.mode === 'code')).toHaveLength(0);
  });
});
