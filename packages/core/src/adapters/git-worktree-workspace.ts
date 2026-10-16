/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { DiffStat, GcOptions, GcRunResult, PatchCheck, RunBase, Workspace, WorkspaceManager } from '../ports/workspace.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('workspace');
const execFileAsync = promisify(execFile);

export const BRANCH_PREFIX = 'concilium/';
export const INTEGRATION_CANDIDATE = 'integration';
const MANIFEST = 'manifest.json';
const CONCILIUM_IDENTITY = {
  GIT_AUTHOR_NAME: 'concilium',
  GIT_AUTHOR_EMAIL: 'concilium@localhost',
  GIT_COMMITTER_NAME: 'concilium',
  GIT_COMMITTER_EMAIL: 'concilium@localhost',
};
/** Ids become a directory name and a ref component: no dots, slashes or leading dash. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Inherited from a git hook, these would point every command at the wrong repo or index. */
const GIT_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX'];

export function candidateBranch(runId: string, candidateId: string): string {
  return `${BRANCH_PREFIX}${runId}/${candidateId}`;
}

export function integrationBranch(runId: string): string {
  return candidateBranch(runId, INTEGRATION_CANDIDATE);
}

export class DirtyWorktreeError extends Error {
  constructor(readonly repoDir: string, readonly status: string) {
    super(`${repoDir} has uncommitted changes. Commit or stash them, or pass includeDirty to snapshot them:\n${status}`);
    this.name = 'DirtyWorktreeError';
  }
}

type Manifest = RunBase & {
  version: 1;
  status: 'active' | 'finished';
  /** The process that created the run. A run whose owner is gone crashed, and gc collects it. */
  owner: { pid: number; host: string };
  candidates: string[];
  createdAt: string;
};

type GitWorktree = { path: string; branch?: string };

function assertId(kind: string, id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid ${kind} "${id}": use letters, digits, "_" or "-" (at most 64)`);
}

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const name of GIT_LOCATION_VARS) if (!(name in extra)) delete env[name];
  return env;
}

async function git(cwd: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnv(extraEnv), maxBuffer: 64 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr || (err instanceof Error ? err.message : String(err))}`);
  }
}

function parseWorktreeList(porcelain: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  for (const block of porcelain.split(/\n\n+/)) {
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length);
    }
    if (path) worktrees.push({ path, branch });
  }
  return worktrees;
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<Manifest>;
  return m.version === 1 && typeof m.runId === 'string' && typeof m.repoDir === 'string' && typeof m.baseSha === 'string'
    && Array.isArray(m.candidates) && typeof m.owner?.pid === 'number';
}

function ownerAlive(owner: Manifest['owner']): boolean {
  if (owner.host !== hostname()) return true; // Can't tell from here, so never collect it.
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * `WorkspaceManager` on `git worktree`. Worktrees live at `<root>/<repo-hash>/<run-id>/<candidate-id>` next to a
 * run manifest (`<root>/<repo-hash>/<run-id>/manifest.json`), written before any worktree so a crash leaves a record.
 * Recovery reconciles the manifest with `git worktree list --porcelain` and `git worktree prune`.
 */
export class GitWorktreeWorkspace implements WorkspaceManager {
  readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { root: string }) {
    mkdirSync(options.root, { recursive: true });
    // git records worktree paths resolved, so compare against a resolved root.
    this.root = realpathSync(options.root);
  }

  async startRun(input: { repoDir: string; runId: string; includeDirty?: boolean }): Promise<RunBase> {
    assertId('run id', input.runId);
    return this.serial(async () => {
      const repoDir = await this.repoRoot(input.repoDir);
      const existing = await this.readManifest(this.runDir(repoDir, input.runId));
      if (existing) return toBase(existing);

      const headSha = await git(repoDir, ['rev-parse', '--verify', 'HEAD^{commit}']);
      const status = await git(repoDir, ['status', '--porcelain']);
      let baseSha = headSha;
      let snapshotRef: string | undefined;
      if (status) {
        if (!input.includeDirty) throw new DirtyWorktreeError(repoDir, status);
        snapshotRef = `refs/concilium/${input.runId}/snapshot`;
        baseSha = await this.snapshot(repoDir, headSha, input.runId, snapshotRef);
      }

      const manifest: Manifest = {
        version: 1,
        runId: input.runId,
        repoDir,
        headSha,
        baseSha,
        ...(snapshotRef ? { snapshotRef } : {}),
        status: 'active',
        owner: { pid: process.pid, host: hostname() },
        candidates: [],
        createdAt: new Date().toISOString(),
      };
      await this.writeManifest(manifest);
      return toBase(manifest);
    });
  }

  async create(input: { repoDir: string; runId: string; candidateId: string; fromSha?: string }): Promise<Workspace> {
    assertId('run id', input.runId);
    assertId('candidate id', input.candidateId);
    return this.serial(async () => {
      const repoDir = await this.repoRoot(input.repoDir);
      const manifest = await this.readManifest(this.runDir(repoDir, input.runId));
      if (!manifest) throw new Error(`Run ${input.runId} has no base for ${repoDir}: call startRun first`);

      const path = join(this.runDir(repoDir, input.runId), input.candidateId);
      const branch = candidateBranch(input.runId, input.candidateId);
      if (!manifest.candidates.includes(input.candidateId)) {
        manifest.candidates.push(input.candidateId);
        await this.writeManifest(manifest);
      }

      const current = (await this.gitWorktrees(repoDir)).find((w) => w.path === path);
      if (current && existsSync(path) && current.branch === branch) return this.workspace(manifest, input.candidateId, 'ready');
      // A worktree dir deleted by hand or a crashed `git worktree add`: clear what is left, then add it again.
      if (current) await this.removeWorktree(repoDir, path);
      await rm(path, { recursive: true, force: true });
      await git(repoDir, ['worktree', 'prune']);

      const branchExists = await git(repoDir, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]);
      if (branchExists) {
        await git(repoDir, ['worktree', 'add', path, branch]);
      } else {
        await git(repoDir, ['worktree', 'add', '-b', branch, path, input.fromSha ?? manifest.baseSha]);
      }
      log.debug(`Created worktree ${path} on ${branch}`);
      return this.workspace(manifest, input.candidateId, 'ready');
    });
  }

  async list(input: { repoDir: string; runId?: string }): Promise<Workspace[]> {
    return this.serial(async () => {
      const repoDir = await this.repoRoot(input.repoDir);
      const repoRunsDir = join(this.root, repoHash(repoDir));
      const runIds = input.runId ? [input.runId] : await listDirs(repoRunsDir);
      const live = new Set((await this.gitWorktrees(repoDir)).map((w) => w.path));
      const workspaces: Workspace[] = [];
      for (const runId of runIds) {
        const manifest = await this.readManifest(join(repoRunsDir, runId));
        if (!manifest) continue;
        for (const candidateId of manifest.candidates) {
          const path = join(repoRunsDir, runId, candidateId);
          workspaces.push(this.workspace(manifest, candidateId, live.has(path) && existsSync(path) ? 'ready' : 'missing'));
        }
      }
      return workspaces;
    });
  }

  async remove(input: { repoDir: string; runId: string; candidateId: string }): Promise<void> {
    assertId('run id', input.runId);
    assertId('candidate id', input.candidateId);
    return this.serial(async () => {
      const repoDir = await this.repoRoot(input.repoDir);
      const runDir = this.runDir(repoDir, input.runId);
      const path = join(runDir, input.candidateId);
      if ((await this.gitWorktrees(repoDir)).some((w) => w.path === path)) await this.removeWorktree(repoDir, path);
      await rm(path, { recursive: true, force: true });
      await git(repoDir, ['worktree', 'prune']);

      const manifest = await this.readManifest(runDir);
      if (manifest?.candidates.includes(input.candidateId)) {
        manifest.candidates = manifest.candidates.filter((id) => id !== input.candidateId);
        await this.writeManifest(manifest);
      }
    });
  }

  async commit(input: { repoDir: string; runId: string; candidateId: string; message: string }): Promise<{ headSha: string; committed: boolean }> {
    assertId('run id', input.runId);
    assertId('candidate id', input.candidateId);
    return this.serial(async () => {
      const repoDir = await this.repoRoot(input.repoDir);
      const path = join(this.runDir(repoDir, input.runId), input.candidateId);
      if (!existsSync(path)) throw new Error(`Candidate ${input.candidateId} of run ${input.runId} has no worktree at ${path}`);
      await git(path, ['add', '--all']);
      const staged = await git(path, ['diff', '--cached', '--name-only']);
      // The candidate's work is recorded as it is, so the target repo's commit hooks do not run.
      if (staged) await git(path, ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', input.message], CONCILIUM_IDENTITY);
      return { headSha: await git(path, ['rev-parse', 'HEAD']), committed: staged !== '' };
    });
  }

  async diffStat(input: { repoDir: string; runId: string; candidateId: string }): Promise<DiffStat> {
    assertId('run id', input.runId);
    assertId('candidate id', input.candidateId);
    return this.serial(async () => {
      const repoDir = await this.repoRoot(input.repoDir);
      const manifest = await this.readManifest(this.runDir(repoDir, input.runId));
      if (!manifest) throw new Error(`Run ${input.runId} has no base for ${repoDir}`);
      const range = `${manifest.baseSha}..${candidateBranch(input.runId, input.candidateId)}`;
      const stat: DiffStat = { commits: Number(await git(repoDir, ['rev-list', '--count', range])), filesChanged: 0, insertions: 0, deletions: 0 };
      for (const line of (await git(repoDir, ['diff', '--numstat', range])).split('\n').filter(Boolean)) {
        const [added, deleted] = line.split('\t');
        stat.filesChanged++;
        // Binary files show "-" for both counts.
        stat.insertions += Number(added) || 0;
        stat.deletions += Number(deleted) || 0;
      }
      return stat;
    });
  }

  async revert(input: { repoDir: string; runId: string; candidateId: string; sha: string; message: string }): Promise<string> {
    assertId('run id', input.runId);
    assertId('candidate id', input.candidateId);
    return this.serial(async () => {
      const repoDir = await this.repoRoot(input.repoDir);
      const path = join(this.runDir(repoDir, input.runId), input.candidateId);
      if (!existsSync(path)) throw new Error(`Candidate ${input.candidateId} of run ${input.runId} has no worktree at ${path}`);
      await git(path, ['revert', '--no-commit', input.sha]);
      await git(path, ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', input.message], CONCILIUM_IDENTITY);
      return git(path, ['rev-parse', 'HEAD']);
    });
  }

  async patch(input: { repoDir: string; runId: string; candidateId: string }): Promise<string> {
    assertId('run id', input.runId);
    assertId('candidate id', input.candidateId);
    return this.serial(async () => {
      const repoDir = await this.repoRoot(input.repoDir);
      const manifest = await this.readManifest(this.runDir(repoDir, input.runId));
      if (!manifest) throw new Error(`Run ${input.runId} has no base for ${repoDir}`);
      const diff = await git(repoDir, ['-c', 'core.quotePath=false', 'diff', '--binary', '--no-color', '--no-ext-diff', manifest.baseSha, candidateBranch(input.runId, input.candidateId)]);
      // git() trims the output; a patch must end with its newline.
      return diff ? `${diff}\n` : '';
    });
  }

  async checkPatch(input: { repoDir: string; patch: string }): Promise<PatchCheck> {
    return this.serial(async () => {
      const repoDir = await this.repoRoot(input.repoDir);
      const targetSha = await git(repoDir, ['rev-parse', '--verify', 'HEAD^{commit}']);
      // A scratch index holding HEAD: the check ignores the user's index and working tree.
      const tempDir = await mkdtemp(join(tmpdir(), 'concilium-patch-'));
      try {
        const env = { GIT_INDEX_FILE: join(tempDir, 'index') };
        const file = join(tempDir, 'result.patch');
        await writeFile(file, input.patch);
        await git(repoDir, ['read-tree', targetSha], env);
        return await git(repoDir, ['apply', '--check', '--cached', file], env).then(
          () => ({ applies: true, targetSha, output: '' }),
          (err: Error) => ({ applies: false, targetSha, output: err.message }),
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  }

  async finishRun(input: { repoDir: string; runId: string }): Promise<void> {
    assertId('run id', input.runId);
    return this.serial(async () => {
      const repoDir = await this.repoRoot(input.repoDir);
      const manifest = await this.readManifest(this.runDir(repoDir, input.runId));
      if (!manifest || manifest.status === 'finished') return;
      manifest.status = 'finished';
      await this.writeManifest(manifest);
    });
  }

  async gc(options: GcOptions = {}): Promise<GcRunResult[]> {
    if (options.runId) assertId('run id', options.runId);
    return this.serial(async () => {
      const results: GcRunResult[] = [];
      for (const hash of await listDirs(this.root)) {
        for (const runId of await listDirs(join(this.root, hash))) {
          if (options.runId && runId !== options.runId) continue;
          const runDir = join(this.root, hash, runId);
          const manifest = await this.readManifest(runDir);
          if (!manifest) {
            results.push({ ...emptyResult(runId, ''), errors: [`${runDir} has no readable ${MANIFEST}; left in place`] });
            continue;
          }
          results.push(await this.collectRun(manifest, runDir, options));
        }
        if (!options.dryRun) await rmdir(join(this.root, hash)).catch(() => undefined); // only once no run is left
      }
      return results;
    });
  }

  private async collectRun(manifest: Manifest, runDir: string, options: GcOptions): Promise<GcRunResult> {
    const result = emptyResult(manifest.runId, manifest.repoDir);
    if (manifest.status === 'active' && ownerAlive(manifest.owner)) return { ...result, skipped: 'active' };

    const repoDir = manifest.repoDir;
    const repoExists = existsSync(repoDir) && (await git(repoDir, ['rev-parse', '--git-dir']).then(() => true, () => false));
    if (repoExists) {
      const worktrees = (await this.gitWorktrees(repoDir)).filter((w) => w.path.startsWith(runDir + sep));
      const branches = (await git(repoDir, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${BRANCH_PREFIX}${manifest.runId}/`]))
        .split('\n').filter(Boolean);
      const refs = (await git(repoDir, ['for-each-ref', '--format=%(refname)', `refs/concilium/${manifest.runId}/`]))
        .split('\n').filter(Boolean);

      for (const worktree of worktrees) {
        if (!options.dryRun) await this.removeWorktree(repoDir, worktree.path).catch((err: Error) => result.errors.push(err.message));
        result.removedWorktrees.push(worktree.path);
      }
      if (!options.dryRun) await git(repoDir, ['worktree', 'prune']).catch((err: Error) => result.errors.push(err.message));

      for (const branch of branches) {
        // for-each-ref already limits this to concilium/<run-id>/; the check keeps any other branch out by construction.
        if (!branch.startsWith(`${BRANCH_PREFIX}${manifest.runId}/`)) continue;
        if (branch === integrationBranch(manifest.runId) && !options.includeIntegration) {
          result.keptBranches.push(branch);
          continue;
        }
        if (!options.dryRun) {
          const deleted = await git(repoDir, ['branch', '-D', branch]).then(() => true, (err: Error) => (result.errors.push(err.message), false));
          if (!deleted) continue;
        }
        result.deletedBranches.push(branch);
      }
      for (const ref of refs) {
        if (!options.dryRun) await git(repoDir, ['update-ref', '-d', ref]).catch((err: Error) => result.errors.push(err.message));
        result.deletedRefs.push(ref);
      }
    }

    if (options.dryRun || result.errors.length > 0) return result;
    if (result.keptBranches.length > 0) {
      // Keep only the manifest, so a later gc can still find the kept integration branch.
      for (const entry of await listDirs(runDir)) await rm(join(runDir, entry), { recursive: true, force: true });
      await this.writeManifest({ ...manifest, status: 'finished', candidates: [] });
    } else {
      await rm(runDir, { recursive: true, force: true });
    }
    return result;
  }

  /** Commit the working tree (tracked and untracked, minus ignored files) through a temp index, leaving the user's index alone. */
  private async snapshot(repoDir: string, headSha: string, runId: string, ref: string): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'concilium-snapshot-'));
    try {
      const index = join(tempDir, 'index');
      const userIndex = resolve(repoDir, await git(repoDir, ['rev-parse', '--git-path', 'index']));
      if (existsSync(userIndex)) await copyFile(userIndex, index); // its stat cache spares rehashing unchanged files
      const env = { GIT_INDEX_FILE: index };
      await git(repoDir, ['add', '--all'], env);
      const tree = await git(repoDir, ['write-tree'], env);
      const sha = await git(repoDir, ['commit-tree', '--no-gpg-sign', tree, '-p', headSha, '-m', `concilium: snapshot of the dirty tree for run ${runId}`], CONCILIUM_IDENTITY);
      await git(repoDir, ['update-ref', ref, sha]);
      return sha;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async removeWorktree(repoDir: string, path: string): Promise<void> {
    // Twice --force also removes a locked worktree, such as one left by a killed `git worktree add`.
    await git(repoDir, ['worktree', 'remove', '--force', '--force', path]).catch(async (err: Error) => {
      log.debug(`git worktree remove failed, deleting the directory: ${err.message}`);
      await rm(path, { recursive: true, force: true });
      await git(repoDir, ['worktree', 'prune']);
    });
  }

  private async gitWorktrees(repoDir: string): Promise<GitWorktree[]> {
    return parseWorktreeList(await git(repoDir, ['worktree', 'list', '--porcelain']));
  }

  private async repoRoot(dir: string): Promise<string> {
    return realpathSync(await git(dir, ['rev-parse', '--show-toplevel']));
  }

  private runDir(repoDir: string, runId: string): string {
    return join(this.root, repoHash(repoDir), runId);
  }

  private workspace(manifest: Manifest, candidateId: string, state: Workspace['state']): Workspace {
    return {
      runId: manifest.runId,
      candidateId,
      path: join(this.runDir(manifest.repoDir, manifest.runId), candidateId),
      branch: candidateBranch(manifest.runId, candidateId),
      state,
    };
  }

  private async readManifest(runDir: string): Promise<Manifest | null> {
    try {
      const value: unknown = JSON.parse(await readFile(join(runDir, MANIFEST), 'utf8'));
      return isManifest(value) ? value : null;
    } catch {
      return null; // Missing or half-written: the caller treats the run as unknown.
    }
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    const runDir = this.runDir(manifest.repoDir, manifest.runId);
    await mkdir(runDir, { recursive: true });
    const temp = join(runDir, `.${MANIFEST}.${process.pid}.tmp`);
    await writeFile(temp, JSON.stringify(manifest, null, 2) + '\n');
    await rename(temp, join(runDir, MANIFEST));
  }

  /** One operation at a time per manager: manifests are read-modify-write and git locks its own metadata. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function toBase(manifest: Manifest): RunBase {
  const { runId, repoDir, headSha, baseSha, snapshotRef } = manifest;
  return { runId, repoDir, headSha, baseSha, ...(snapshotRef ? { snapshotRef } : {}) };
}

function emptyResult(runId: string, repoDir: string): GcRunResult {
  return { runId, repoDir, removedWorktrees: [], deletedBranches: [], deletedRefs: [], keptBranches: [], errors: [] };
}

function repoHash(repoDir: string): string {
  return createHash('sha256').update(repoDir).digest('hex').slice(0, 16);
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}
