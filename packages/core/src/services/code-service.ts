/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { randomBytes } from 'node:crypto';
import type { Brief } from '../domain/driver/brief.js';
import type { DriverUsage } from '../domain/driver/normalized-event.js';
import type { Report, ReportStatus } from '../domain/driver/report.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import type { DiffStat, WorkspaceManager } from '../ports/workspace.js';
import { candidateBranch } from '../adapters/git-worktree-workspace.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('code');

/** Wall-clock limit for one candidate. */
export const CODE_TIMEOUT_MS = 30 * 60_000;

/** One agent CLI asked to write code, on its own default model unless `model` is set. */
export type CodeAgent = { provider: string; model?: string };

/** One candidate's outcome. Its work is the branch, from the run's base to `headSha`. */
export type CodeCandidate = {
  candidateId: string;
  provider: string;
  model: string | null;
  /** The driver's report status, or `error` when the worktree, the driver or the commit failed. */
  status: ReportStatus;
  branch: string;
  worktree: string;
  /** The branch head after the commit, or null when no worktree was made. */
  headSha: string | null;
  /** Whether Concilium committed changes the agent left uncommitted. */
  committed: boolean;
  diffStat: DiffStat | null;
  durationMs: number;
  usage: DriverUsage | null;
  errors: string[];
  /** What the agent was told, and what it said at the end. */
  brief: Brief | null;
  finalText: string;
};

export type CodeRunRecord = {
  version: 1;
  kind: 'code';
  id: string;
  createdAt: string;
  finishedAt: string;
  task: string;
  repoDir: string;
  /** `HEAD` of the user's checkout when the run started. */
  headSha: string;
  /** What every candidate branched from: `headSha`, or the dirty-tree snapshot on top of it. */
  baseSha: string;
  snapshotRef?: string;
  candidates: CodeCandidate[];
};

export type CodeRunInput = {
  task: string;
  /** Any directory inside the target repo. */
  repoDir: string;
  agents: CodeAgent[];
  includeDirty?: boolean;
  timeoutMs?: number;
  /** Defaults to a new id. */
  runId?: string;
  drivers: ReadonlyMap<string, HeadlessCliDriver>;
  workspace: WorkspaceManager;
  signal?: AbortSignal;
  onCandidateStart?: (candidate: { candidateId: string; provider: string; worktree: string }) => void;
  onCandidateDone?: (candidate: CodeCandidate) => void;
};

/** A run id that sorts by start time and is a safe directory and ref component: `20261016T141015-a1b2c3`. */
export function newRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
}

/** `claude`, `codex`, then `claude-2` for a second Claude agent. */
function candidateIds(agents: CodeAgent[]): string[] {
  const seen = new Map<string, number>();
  return agents.map(({ provider }) => {
    const n = (seen.get(provider) ?? 0) + 1;
    seen.set(provider, n);
    return n === 1 ? provider : `${provider}-${n}`;
  });
}

/** The write-mode brief a candidate gets: its own worktree, read, write and shell. Each driver keeps what its CLI can do safely. */
export function codeBrief(task: string, worktree: string, branch: string): Brief {
  return {
    version: 1,
    task,
    mode: 'code',
    cwd: worktree,
    constraints: [
      `You are in ${worktree}, a git worktree of the project on branch ${branch}. Make every change inside this directory.`,
      'You do not need to commit: Concilium commits what you leave in the working tree when you finish. Do not push, and do not create or switch branches.',
    ],
    allowedActions: ['read', 'write', 'shell'],
  };
}

function commitMessage(task: string, candidate: CodeCandidate, runId: string): string {
  const agent = candidate.model ? `${candidate.provider} (${candidate.model})` : candidate.provider;
  return `concilium: ${candidate.candidateId} candidate for run ${runId}\n\nTask: ${task}\nAgent: ${agent}\nStatus: ${candidate.status}\n`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runDriver(driver: HeadlessCliDriver, brief: Brief, model: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<Report> {
  let report: Report | undefined;
  for await (const event of driver.run(brief, { cwd: brief.cwd, model, timeoutMs, signal })) {
    if (event.type === 'done') report = event.report;
  }
  if (!report) throw new Error(`${driver.id} ended without a report`);
  return report;
}

/**
 * Pins the repo's base, gives every agent its own worktree and branch, runs them in parallel on a write-mode
 * brief, then commits what each left behind and records the result. A failing candidate never stops the others.
 * The user's checkout is not touched. Worktrees stay for inspection; the run is marked finished so `gc` collects it.
 */
export async function runCodeCandidates(input: CodeRunInput): Promise<CodeRunRecord> {
  const runId = input.runId ?? newRunId();
  const createdAt = new Date().toISOString();
  const timeoutMs = input.timeoutMs ?? CODE_TIMEOUT_MS;
  const signal = input.signal ?? new AbortController().signal;
  const base = await input.workspace.startRun({ repoDir: input.repoDir, runId, includeDirty: input.includeDirty });
  const repoDir = base.repoDir;
  log.info(`code run ${runId}: ${input.agents.length} candidates from ${base.baseSha}`);

  const runCandidate = async (agent: CodeAgent, candidateId: string): Promise<CodeCandidate> => {
    const candidate: CodeCandidate = {
      candidateId,
      provider: agent.provider,
      model: agent.model || null,
      status: 'error',
      branch: candidateBranch(runId, candidateId),
      worktree: '',
      headSha: null,
      committed: false,
      diffStat: null,
      durationMs: 0,
      usage: null,
      errors: [],
      brief: null,
      finalText: '',
    };
    const startedAt = Date.now();
    try {
      const workspace = await input.workspace.create({ repoDir, runId, candidateId });
      candidate.worktree = workspace.path;
      input.onCandidateStart?.({ candidateId, provider: agent.provider, worktree: workspace.path });
      candidate.brief = codeBrief(input.task, workspace.path, workspace.branch);

      const driver = input.drivers.get(agent.provider);
      if (!driver) throw new Error(`No agent CLI driver for "${agent.provider}"`);
      const report = await runDriver(driver, candidate.brief, agent.model || undefined, timeoutMs, signal);
      candidate.status = report.status;
      candidate.usage = report.usage;
      candidate.errors.push(...report.errors);
      candidate.finalText = report.finalText;
    } catch (err) {
      candidate.status = 'error';
      candidate.errors.push(errorMessage(err));
    }
    candidate.durationMs = Date.now() - startedAt;

    // Whatever the agent left, even after a failure, goes on its branch so it can be inspected.
    if (candidate.worktree) {
      try {
        const commit = await input.workspace.commit({ repoDir, runId, candidateId, message: commitMessage(input.task, candidate, runId) });
        candidate.headSha = commit.headSha;
        candidate.committed = commit.committed;
        candidate.diffStat = await input.workspace.diffStat({ repoDir, runId, candidateId });
      } catch (err) {
        candidate.status = 'error';
        candidate.errors.push(errorMessage(err));
      }
    }
    log.info(`code run ${runId}: ${candidateId} ${candidate.status}`);
    input.onCandidateDone?.(candidate);
    return candidate;
  };

  try {
    const ids = candidateIds(input.agents);
    const candidates = await Promise.all(input.agents.map((agent, i) => runCandidate(agent, ids[i])));
    return {
      version: 1,
      kind: 'code',
      id: runId,
      createdAt,
      finishedAt: new Date().toISOString(),
      task: input.task,
      repoDir,
      headSha: base.headSha,
      baseSha: base.baseSha,
      ...(base.snapshotRef ? { snapshotRef: base.snapshotRef } : {}),
      candidates,
    };
  } finally {
    await input.workspace.finishRun({ repoDir, runId });
  }
}
