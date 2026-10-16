/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

/** The commit every candidate of a run starts from. */
export type RunBase = {
  runId: string;
  /** The target repo's top-level directory. */
  repoDir: string;
  /** `HEAD` of the target repo when the run started. */
  headSha: string;
  /** The commit candidates branch from: `headSha`, or the dirty-tree snapshot on top of it. */
  baseSha: string;
  /** Set when the dirty tree was snapshotted (`includeDirty`): the scratch ref that holds `baseSha`. */
  snapshotRef?: string;
};

export type Workspace = {
  runId: string;
  candidateId: string;
  /** The worktree directory, outside the target repo. */
  path: string;
  /** `concilium/<run-id>/<candidate-id>`. */
  branch: string;
  /** `ready`: the worktree is checked out. `missing`: recorded for the run, but git has no worktree at `path`. */
  state: 'ready' | 'missing';
};

export type GcRunResult = {
  runId: string;
  repoDir: string;
  /** `active`: the process that owns the run is still alive, so nothing was touched. */
  skipped?: 'active';
  removedWorktrees: string[];
  deletedBranches: string[];
  deletedRefs: string[];
  /** Branches kept on purpose (the integration branch, unless `includeIntegration`). */
  keptBranches: string[];
  /** Steps that failed. The rest of the run was still collected. */
  errors: string[];
};

/** What a candidate branch changed against the run's base. */
export type DiffStat = {
  /** Commits on the branch since the base. */
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

/** A patch checked against the target repo's `HEAD` at `targetSha`. `output` holds git's complaints when it does not apply. */
export type PatchCheck = { applies: boolean; targetSha: string; output: string };

export type GcOptions = {
  /** Only this run. Without it, every finished or crashed run under the worktree root. */
  runId?: string;
  /** Report what would be removed, change nothing. */
  dryRun?: boolean;
  /** Also delete `concilium/<run-id>/integration`. Kept by default. */
  includeIntegration?: boolean;
};

/**
 * Git worktrees for candidates: one per candidate, all from one pinned base, never inside the user's checkout.
 * Every operation is idempotent and safe to repeat after a crash.
 */
export interface WorkspaceManager {
  /** Pin the run's base. Refuses a dirty tree unless `includeDirty`, which snapshots it to a scratch ref. Repeating returns the same base. */
  startRun(input: { repoDir: string; runId: string; includeDirty?: boolean }): Promise<RunBase>;
  /** Create (or return the existing) worktree on `concilium/<run-id>/<candidate-id>`, from the run's base or `fromSha`. */
  create(input: { repoDir: string; runId: string; candidateId: string; fromSha?: string }): Promise<Workspace>;
  /** The run's recorded workspaces, or every run's for the repo. */
  list(input: { repoDir: string; runId?: string }): Promise<Workspace[]>;
  /** Remove a candidate's worktree. Its branch stays (gc deletes it). */
  remove(input: { repoDir: string; runId: string; candidateId: string }): Promise<void>;
  /**
   * Commit everything left uncommitted in the candidate's worktree (ignored files excepted) on its branch, as
   * `concilium`. Returns the branch head, and whether a commit was made.
   */
  commit(input: { repoDir: string; runId: string; candidateId: string; message: string }): Promise<{ headSha: string; committed: boolean }>;
  /** The candidate branch against the run's base. */
  diffStat(input: { repoDir: string; runId: string; candidateId: string }): Promise<DiffStat>;
  /** Commit the revert of `sha` on the candidate's branch, as `concilium`. Returns the new branch head. */
  revert(input: { repoDir: string; runId: string; candidateId: string; sha: string; message: string }): Promise<string>;
  /** `git diff --binary` from the run's base to the candidate branch head. */
  patch(input: { repoDir: string; runId: string; candidateId: string }): Promise<string>;
  /** Whether `patch` applies to the target repo's current `HEAD` (`git apply --check` on a scratch index; the checkout is not touched). */
  checkPatch(input: { repoDir: string; patch: string }): Promise<PatchCheck>;
  /** Mark the run finished, so gc collects it. */
  finishRun(input: { repoDir: string; runId: string }): Promise<void>;
  /** Remove worktrees, `concilium/` branches and scratch refs of finished (or crashed) runs. */
  gc(options?: GcOptions): Promise<GcRunResult[]>;
}
