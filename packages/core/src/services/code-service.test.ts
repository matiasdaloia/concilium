/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brief } from '../domain/driver/brief.js';
import { FakeCliDriver } from '../adapters/cli/fake-cli-driver.js';
import { DirtyWorktreeError, GitWorktreeWorkspace } from '../adapters/git-worktree-workspace.js';
import { JsonCodeRunStore } from '../adapters/json-code-run-store.js';
import { setLogLevel } from '../shared/logger.js';
import { runCodeCandidates } from './code-service.js';

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
      const [{ brief, opts }] = drivers.get(driver)!.runs;
      expect(brief).toMatchObject({ mode: 'code', allowedActions: ['read', 'write', 'shell'], task: 'validate the inputs of sum' });
      expect(brief.cwd).toBe(record.candidates.find((c) => c.provider === driver)!.worktree);
      expect(opts.cwd).toBe(brief.cwd);
      expect(brief.cwd.startsWith(repo)).toBe(false);
    }
    expect(drivers.get('codex')!.runs[0].opts.model).toBe('gpt-5.2');

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

  it('should save the record under runs/<id>/run.json', async () => {
    const drivers = new Map([['claude', writer('claude', { 'x.txt': 'x\n' })]]);
    const record = await runCodeCandidates({ task: 't', repoDir: repo, agents: [{ provider: 'claude' }], runId: 'run5', drivers, workspace });
    const store = new JsonCodeRunStore(join(sandbox, `data-${counter}`));

    expect(await store.save(record)).toBe(join(sandbox, `data-${counter}`, 'runs', 'run5', 'run.json'));
    expect(await store.load('run5')).toEqual(record);
  });
});
