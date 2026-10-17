/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirtyWorktreeError, GitWorktreeWorkspace, candidateBranch, integrationBranch } from './git-worktree-workspace.js';
import { setLogLevel } from '../shared/logger.js';

const sandbox = mkdtempSync(join(tmpdir(), 'concilium-worktree-test-'));
const gitConfig = join(sandbox, 'gitconfig');
let repo: string;
let root: string;
let manager: GitWorktreeWorkspace;
let counter = 0;

// Keep git away from the user's ~/.gitconfig and the system config.
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
  root = join(sandbox, `worktrees-${counter}`);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored.log\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  manager = new GitWorktreeWorkspace({ root });
});

function worktreePaths(): string[] {
  return git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
}

function branches(): string[] {
  return git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean).sort();
}

describe('GitWorktreeWorkspace', () => {
  it('should create one worktree per candidate on concilium/<run>/<candidate> from HEAD, outside the repo', async () => {
    const base = await manager.startRun({ repoDir: repo, runId: 'r1' });
    expect(base.baseSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(base.snapshotRef).toBeUndefined();

    const created = await Promise.all(['a', 'b', 'c'].map((candidateId) => manager.create({ repoDir: repo, runId: 'r1', candidateId })));

    for (const ws of created) {
      expect(ws.state).toBe('ready');
      expect(ws.branch).toBe(candidateBranch('r1', ws.candidateId));
      expect(ws.path.startsWith(manager.root)).toBe(true);
      expect(ws.path.startsWith(repo)).toBe(false);
      expect(git(ws.path, 'rev-parse', 'HEAD')).toBe(base.baseSha);
      expect(readFileSync(join(ws.path, 'a.txt'), 'utf8')).toBe('one\n');
    }
    expect(worktreePaths()).toEqual(expect.arrayContaining(created.map((w) => w.path)));
    expect(branches()).toEqual(['concilium/r1/a', 'concilium/r1/b', 'concilium/r1/c', 'main']);
    expect((await manager.list({ repoDir: repo, runId: 'r1' })).map((w) => w.candidateId)).toEqual(['a', 'b', 'c']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('should return the same worktree when create is repeated, keeping its commits', async () => {
    await manager.startRun({ repoDir: repo, runId: 'r1' });
    const first = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });
    writeFileSync(join(first.path, 'b.txt'), 'work\n');
    git(first.path, 'add', '.');
    git(first.path, 'commit', '-q', '-m', 'candidate work');
    const head = git(first.path, 'rev-parse', 'HEAD');

    const again = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });

    expect(again).toEqual(first);
    expect(git(again.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(worktreePaths().filter((p) => p === first.path)).toHaveLength(1);
    expect(await manager.list({ repoDir: repo })).toHaveLength(1);
  });

  it('should return the same base when startRun is repeated', async () => {
    const first = await manager.startRun({ repoDir: repo, runId: 'r1' });
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    git(repo, 'commit', '-q', '-am', 'moved on');

    expect(await manager.startRun({ repoDir: repo, runId: 'r1' })).toEqual(first);
  });

  it('should recover a worktree whose directory was deleted by hand', async () => {
    await manager.startRun({ repoDir: repo, runId: 'r1' });
    const ws = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });
    writeFileSync(join(ws.path, 'b.txt'), 'work\n');
    git(ws.path, 'add', '.');
    git(ws.path, 'commit', '-q', '-m', 'candidate work');
    const head = git(ws.path, 'rev-parse', 'HEAD');
    rmSync(ws.path, { recursive: true, force: true });

    expect(await manager.list({ repoDir: repo, runId: 'r1' })).toEqual([{ ...ws, state: 'missing' }]);
    const recovered = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });

    expect(recovered.state).toBe('ready');
    expect(git(recovered.path, 'rev-parse', 'HEAD')).toBe(head); // the branch kept the candidate's commit
    expect(readFileSync(join(recovered.path, 'b.txt'), 'utf8')).toBe('work\n');
  });

  it('should recover a stray directory that git does not know as a worktree', async () => {
    await manager.startRun({ repoDir: repo, runId: 'r1' });
    const ws = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });
    git(repo, 'worktree', 'remove', '--force', ws.path);
    mkdirSync(ws.path);
    writeFileSync(join(ws.path, 'leftover'), 'x');

    const recovered = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });

    expect(recovered.state).toBe('ready');
    expect(existsSync(join(ws.path, 'leftover'))).toBe(false);
    expect(worktreePaths()).toContain(ws.path);
  });

  it('should remove a worktree idempotently and keep its branch', async () => {
    await manager.startRun({ repoDir: repo, runId: 'r1' });
    const ws = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });

    await manager.remove({ repoDir: repo, runId: 'r1', candidateId: 'a' });
    await manager.remove({ repoDir: repo, runId: 'r1', candidateId: 'a' });

    expect(existsSync(ws.path)).toBe(false);
    expect(worktreePaths()).not.toContain(ws.path);
    expect(branches()).toContain('concilium/r1/a');
    expect(await manager.list({ repoDir: repo, runId: 'r1' })).toEqual([]);
  });

  it('should pin a given base commit instead of HEAD, even on a dirty tree, and refuse one that is not a commit', async () => {
    const first = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'branch', 'stacked');
    git(repo, 'switch', '-q', 'stacked');
    writeFileSync(join(repo, 'a.txt'), 'stacked\n');
    git(repo, 'commit', '-q', '-am', 'stacked work');
    const stacked = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-q', 'main');
    writeFileSync(join(repo, 'a.txt'), 'edited\n');

    const base = await manager.startRun({ repoDir: repo, runId: 'r1', baseSha: stacked });
    const ws = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });

    expect(base).toMatchObject({ headSha: first, baseSha: stacked });
    expect(base.snapshotRef).toBeUndefined();
    expect(readFileSync(join(ws.path, 'a.txt'), 'utf8')).toBe('stacked\n');
    expect(git(repo, 'status', '--porcelain')).toBe(' M a.txt');
    await expect(manager.startRun({ repoDir: repo, runId: 'r2', baseSha: 'deadbeef' })).rejects.toThrow(/deadbeef/);
    await expect(manager.startRun({ repoDir: repo, runId: 'r3', baseSha: stacked, includeDirty: true })).rejects.toThrow(/not both/);
  });

  it('should refuse a dirty tree without includeDirty', async () => {
    writeFileSync(join(repo, 'a.txt'), 'edited\n');

    await expect(manager.startRun({ repoDir: repo, runId: 'r1' })).rejects.toBeInstanceOf(DirtyWorktreeError);
    await expect(manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' })).rejects.toThrow(/startRun/);
    expect(worktreePaths()).toEqual([git(repo, 'rev-parse', '--show-toplevel')]);
  });

  it('should snapshot a dirty tree with includeDirty so every candidate starts from the same bytes', async () => {
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    writeFileSync(join(repo, 'ignored.log'), 'noise\n');
    git(repo, 'add', 'a.txt'); // a staged change, which the user's index must keep
    const statusBefore = git(repo, 'status', '--porcelain');
    const head = git(repo, 'rev-parse', 'HEAD');

    const base = await manager.startRun({ repoDir: repo, runId: 'r1', includeDirty: true });
    const [a, b] = await Promise.all(['a', 'b'].map((candidateId) => manager.create({ repoDir: repo, runId: 'r1', candidateId })));

    expect(base.headSha).toBe(head);
    expect(base.baseSha).not.toBe(head);
    expect(git(repo, 'rev-parse', `${base.baseSha}^`)).toBe(head);
    expect(git(repo, 'rev-parse', base.snapshotRef!)).toBe(base.baseSha);
    for (const ws of [a, b]) {
      expect(git(ws.path, 'rev-parse', 'HEAD')).toBe(base.baseSha);
      expect(readFileSync(join(ws.path, 'a.txt'), 'utf8')).toBe('edited\n');
      expect(readFileSync(join(ws.path, 'new.txt'), 'utf8')).toBe('untracked\n');
      expect(existsSync(join(ws.path, 'ignored.log'))).toBe(false);
    }
    // The user's checkout, index and HEAD are untouched.
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(branches()).not.toContain(expect.stringContaining('snapshot'));
  });

  it('should reject ids that are not a safe path and ref component', async () => {
    for (const runId of ['../x', 'a/b', '.hidden', 'a..b', '-x', '']) {
      await expect(manager.startRun({ repoDir: repo, runId })).rejects.toThrow(/Invalid run id/);
    }
  });

  it('should commit what a candidate left in its worktree as concilium, skipping ignored files, and count it against the base', async () => {
    const base = await manager.startRun({ repoDir: repo, runId: 'r1' });
    const ws = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });
    writeFileSync(join(ws.path, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(ws.path, 'new.txt'), 'x\ny\n');
    writeFileSync(join(ws.path, 'ignored.log'), 'noise\n');

    const result = await manager.commit({ repoDir: repo, runId: 'r1', candidateId: 'a', message: 'candidate a' });

    expect(result.committed).toBe(true);
    expect(result.headSha).toBe(git(repo, 'rev-parse', ws.branch));
    expect(git(repo, 'log', '-1', '--format=%an <%ae>|%s', ws.branch)).toBe('concilium <concilium@localhost>|candidate a');
    expect(git(repo, 'show', `${ws.branch}:new.txt`)).toBe('x\ny');
    expect(git(repo, 'ls-tree', '--name-only', ws.branch)).not.toContain('ignored.log');
    expect(await manager.diffStat({ repoDir: repo, runId: 'r1', candidateId: 'a' })).toEqual({ commits: 1, filesChanged: 2, insertions: 3, deletions: 0 });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(base.headSha);
    expect(git(repo, 'status', '--porcelain')).toBe('');

    const again = await manager.commit({ repoDir: repo, runId: 'r1', candidateId: 'a', message: 'candidate a' });
    expect(again).toEqual({ headSha: result.headSha, committed: false });
  });

  it('should report an untouched candidate as no change', async () => {
    const base = await manager.startRun({ repoDir: repo, runId: 'r1' });
    await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });

    expect(await manager.commit({ repoDir: repo, runId: 'r1', candidateId: 'a', message: 'm' })).toEqual({ headSha: base.baseSha, committed: false });
    expect(await manager.diffStat({ repoDir: repo, runId: 'r1', candidateId: 'a' })).toEqual({ commits: 0, filesChanged: 0, insertions: 0, deletions: 0 });
  });

  it('should revert one commit on a branch built from another candidate head, as concilium', async () => {
    await manager.startRun({ repoDir: repo, runId: 'r1' });
    const a = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });
    writeFileSync(join(a.path, 'a.txt'), 'one\ntwo\n');
    const { headSha: aHead } = await manager.commit({ repoDir: repo, runId: 'r1', candidateId: 'a', message: 'a' });

    const integration = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'integration', fromSha: aHead });
    expect(git(integration.path, 'rev-parse', 'HEAD')).toBe(aHead);
    writeFileSync(join(integration.path, 'b.txt'), 'graft\n');
    const { headSha: graft } = await manager.commit({ repoDir: repo, runId: 'r1', candidateId: 'integration', message: 'graft' });

    const head = await manager.revert({ repoDir: repo, runId: 'r1', candidateId: 'integration', sha: graft, message: 'revert the graft' });
    expect(head).toBe(git(repo, 'rev-parse', integrationBranch('r1')));
    expect(git(repo, 'log', '-1', '--format=%an|%s', head)).toBe('concilium|revert the graft');
    expect(git(repo, 'rev-parse', `${head}^`)).toBe(graft);
    expect(existsSync(join(integration.path, 'b.txt'))).toBe(false);
    expect(git(integration.path, 'status', '--porcelain')).toBe('');
  });

  it('should emit the branch as a patch from the base and check it against the current HEAD without touching the checkout', async () => {
    await manager.startRun({ repoDir: repo, runId: 'r1' });
    const ws = await manager.create({ repoDir: repo, runId: 'r1', candidateId: 'a' });
    writeFileSync(join(ws.path, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(ws.path, 'logo.bin'), Buffer.from([0, 1, 2, 255]));
    await manager.commit({ repoDir: repo, runId: 'r1', candidateId: 'a', message: 'a' });

    const patch = await manager.patch({ repoDir: repo, runId: 'r1', candidateId: 'a' });
    expect(patch).toContain('+two');
    expect(patch).toContain('GIT binary patch');
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(await manager.checkPatch({ repoDir: repo, patch })).toEqual({ applies: true, targetSha: head, output: '' });

    // The target moves on in a way that conflicts; the user's dirty tree does not count either way.
    writeFileSync(join(repo, 'a.txt'), 'uno\n');
    git(repo, 'commit', '-q', '-am', 'moved on');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    const moved = await manager.checkPatch({ repoDir: repo, patch });
    expect(moved).toMatchObject({ applies: false, targetSha: git(repo, 'rev-parse', 'HEAD') });
    expect(moved.output).toContain('a.txt');
    expect(git(repo, 'status', '--porcelain')).toBe(' M a.txt');
    expect(git(repo, 'diff', '--cached')).toBe('');
  });
});

describe('GitWorktreeWorkspace gc', () => {
  async function finishedRun(runId: string, candidates: string[], { integration = false, dirty = false } = {}): Promise<void> {
    if (dirty) writeFileSync(join(repo, 'a.txt'), `dirty ${runId}\n`);
    await manager.startRun({ repoDir: repo, runId, includeDirty: dirty });
    for (const candidateId of candidates) await manager.create({ repoDir: repo, runId, candidateId });
    if (integration) await manager.create({ repoDir: repo, runId, candidateId: 'integration' });
    await manager.finishRun({ repoDir: repo, runId });
  }

  it('should remove finished runs and leave active runs alone', async () => {
    await finishedRun('done', ['a', 'b']);
    await manager.startRun({ repoDir: repo, runId: 'live' });
    const live = await manager.create({ repoDir: repo, runId: 'live', candidateId: 'a' });

    const results = await manager.gc();

    expect(results.find((r) => r.runId === 'live')?.skipped).toBe('active');
    const done = results.find((r) => r.runId === 'done')!;
    expect(done.deletedBranches.sort()).toEqual(['concilium/done/a', 'concilium/done/b']);
    expect(done.removedWorktrees).toHaveLength(2);
    expect(done.errors).toEqual([]);
    expect(branches()).toEqual(['concilium/live/a', 'main']);
    expect(worktreePaths()).toContain(live.path);
    expect(existsSync(join(manager.root))).toBe(true);
    expect(await manager.list({ repoDir: repo, runId: 'done' })).toEqual([]);
  });

  it('should never touch branches outside concilium/, even ones that look like a run', async () => {
    git(repo, 'branch', 'feature');
    git(repo, 'branch', 'r1/a'); // the run's names without the prefix
    git(repo, 'branch', 'concilium/other/a'); // another run's namespace
    git(repo, 'update-ref', 'refs/heads/xconcilium/r1/a', 'HEAD');
    await finishedRun('r1', ['a']);

    await manager.gc({ runId: 'r1', includeIntegration: true });

    expect(branches()).toEqual(['concilium/other/a', 'feature', 'main', 'r1/a', 'xconcilium/r1/a']);
  });

  it('should keep the integration branch unless asked, then delete it on a later gc', async () => {
    await finishedRun('r1', ['a'], { integration: true });

    const [kept] = await manager.gc();
    expect(kept.keptBranches).toEqual([integrationBranch('r1')]);
    expect(kept.deletedBranches).toEqual(['concilium/r1/a']);
    expect(branches()).toEqual(['concilium/r1/integration', 'main']);
    expect(worktreePaths()).toHaveLength(1);

    const [again] = await manager.gc();
    expect(again.keptBranches).toEqual([integrationBranch('r1')]);
    expect(again.deletedBranches).toEqual([]);

    const [deleted] = await manager.gc({ includeIntegration: true });
    expect(deleted.deletedBranches).toEqual(['concilium/r1/integration']);
    expect(branches()).toEqual(['main']);
    expect(await manager.gc()).toEqual([]);
  });

  it('should delete the dirty-tree snapshot ref', async () => {
    await finishedRun('r1', ['a'], { dirty: true });

    const [result] = await manager.gc();

    expect(result.deletedRefs).toEqual(['refs/concilium/r1/snapshot']);
    expect(git(repo, 'for-each-ref', 'refs/concilium/')).toBe('');
  });

  it('should change nothing on a dry run and report what a real run removes', async () => {
    await finishedRun('r1', ['a', 'b']);
    const before = { worktrees: worktreePaths(), branches: branches() };

    const dry = await manager.gc({ dryRun: true });
    expect({ worktrees: worktreePaths(), branches: branches() }).toEqual(before);

    const real = await manager.gc();
    expect(real).toEqual(dry);
    expect(branches()).toEqual(['main']);
  });

  it('should collect a crashed run whose worktree dir and manifest disagree, and be idempotent', async () => {
    await manager.startRun({ repoDir: repo, runId: 'r1' });
    const [a, b] = await Promise.all(['a', 'b', 'c'].map((candidateId) => manager.create({ repoDir: repo, runId: 'r1', candidateId })));
    // The crash: a dir deleted by hand, a worktree git lost track of, and an owner process that is gone.
    rmSync(a.path, { recursive: true, force: true });
    git(repo, 'worktree', 'remove', '--force', b.path);
    const manifestPath = join(a.path, '..', 'manifest.json');
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { owner: { pid: number } };
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, owner: { ...manifest.owner, pid: dead } }));

    const [first] = await manager.gc();
    const stateAfterFirst = { worktrees: worktreePaths(), branches: branches(), status: git(repo, 'status', '--porcelain') };
    const second = await manager.gc();

    expect(first.errors).toEqual([]);
    expect(first.deletedBranches.sort()).toEqual(['concilium/r1/a', 'concilium/r1/b', 'concilium/r1/c']);
    expect(second).toEqual([]);
    expect({ worktrees: worktreePaths(), branches: branches(), status: git(repo, 'status', '--porcelain') }).toEqual(stateAfterFirst);
    expect(stateAfterFirst).toEqual({ worktrees: [git(repo, 'rev-parse', '--show-toplevel')], branches: ['main'], status: '' });
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('prunable');
  });

  it('should collect a run whose repo was deleted', async () => {
    await finishedRun('r1', ['a']);
    rmSync(repo, { recursive: true, force: true });

    const [result] = await manager.gc();

    expect(result.errors).toEqual([]);
    expect(await manager.gc()).toEqual([]);
  });
});
