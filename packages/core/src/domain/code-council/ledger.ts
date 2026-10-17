/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { TaskType } from './playbooks.js';
import type { PrVerdictStatus } from './shipping.js';

/**
 * M8.2. What an implementer's candidate became, first match wins: the synthesis base (else the ranking winner),
 * the donor of an applied graft, blocked or disqualified, a new gate failure, a failed adversarial test of another
 * family, or none of these (it passed but another candidate was picked).
 */
export const IMPLEMENTER_OUTCOMES = ['base', 'grafted', 'dropout', 'gate-failed', 'killed-by-adversary', 'outranked'] as const;
export type ImplementerOutcome = (typeof IMPLEMENTER_OUTCOMES)[number];

/** The ledger's default minimum of runs of a task type before it suggests a candidate set for it. */
export const DEFAULT_MIN_SAMPLE = 10;

/** Who played a role: a `cli[:model]` spec, and the model family of its CLI (null for OpenCode). */
export type Runner = { spec: string; provider: string; model: string | null; family: string | null };

/** What a candidate is judged on in the ranking; `verification` is the `verification` row's verdict, null when not checked. */
export type ImplementerEvidence = {
  verification: 'PASS' | 'ISSUES' | 'DISQUALIFIED' | null;
  newFailures: number;
  penalties: number;
  testsSurvived: number;
  testsCounted: number;
  graftsApplied: number;
};

type RowBase = { runId: string; taskType: TaskType; runner: Runner; wallTimeMs: number | null };

/**
 * One row of the learning ledger per run, role and runner (implementers: per candidate, so a CLI that ran twice in
 * one run has two rows). Each role has its own outcomes:
 * - planner: `framed` (its rubric was frozen) or `fallback` (the playbook's was);
 * - adversary: `landed` (at least one `evidence` or `regression-guard` test), `error` (its run failed with none), else `missed`;
 * - judge (ties and the graft picker): `blocked` when a tie judgment of it is BLOCKED, else `judged`;
 * - integrator: `applied` when at least one of its grafts was applied, else `rejected`;
 * - verifier: the PR verdict.
 */
export type LedgerRow = RowBase & (
  | { role: 'implementer'; candidateId: string; outcome: ImplementerOutcome; evidence: ImplementerEvidence }
  | { role: 'planner'; outcome: 'framed' | 'fallback'; evidence: { criteria: number } }
  | { role: 'adversary'; outcome: 'landed' | 'missed' | 'error'; evidence: { tests: number; valid: number } }
  | { role: 'judge'; outcome: 'judged' | 'blocked'; evidence: { ties: number; blocked: number; graftPicks: number } }
  | { role: 'integrator'; outcome: 'applied' | 'rejected'; evidence: { applied: number; rejected: number } }
  | { role: 'verifier'; outcome: PrVerdictStatus; evidence: { gatesFailed: number; testsFailed: number } }
);

export type LedgerRole = LedgerRow['role'];

export type ImplementerFacts = {
  isBase: boolean;
  graftsApplied: number;
  /** BLOCKED (no head, no change) or disqualified: it could not win. */
  dropped: boolean;
  newFailures: number;
  testsSurvived: number;
  testsCounted: number;
};

export function implementerOutcome(f: ImplementerFacts): ImplementerOutcome {
  if (f.isBase) return 'base';
  if (f.graftsApplied > 0) return 'grafted';
  if (f.dropped) return 'dropout';
  if (f.newFailures > 0) return 'gate-failed';
  if (f.testsSurvived < f.testsCounted) return 'killed-by-adversary';
  return 'outranked';
}

/** Win rate of one runner on one task type, as an implementer: a win is being the base. */
export type RunnerStats = {
  taskType: TaskType;
  runner: Runner;
  /** Candidates it ran. */
  runs: number;
  wins: number;
  winRate: number;
  outcomes: Record<ImplementerOutcome, number>;
  meanWallTimeMs: number | null;
};

/** How often each outcome came up for one runner in one non-implementer role. */
export type RoleStats = { role: Exclude<LedgerRole, 'implementer'>; runner: Runner; runs: number; outcomes: Record<string, number> };

/** At least two runners: the type cannot hold a single-runner set. */
export type CandidateSet = [Runner, Runner, ...Runner[]];

export type RoutingSuggestion = { taskType: TaskType; runs: number; candidates: CandidateSet };

export type WithheldSuggestion = { taskType: TaskType; runs: number; reason: string };

export type LedgerStats = {
  minSample: number;
  /** Code runs read. */
  runs: number;
  byRunner: RunnerStats[];
  byRole: RoleStats[];
  suggestions: RoutingSuggestion[];
  withheld: WithheldSuggestion[];
};

/**
 * The runners in order, keeping only the first of each known family, or null when they cover fewer than two
 * families. The only way to build a `CandidateSet`: a suggested panel stays cross-family.
 */
export function crossFamilySet(ordered: Runner[]): CandidateSet | null {
  const picked: Runner[] = [];
  for (const r of ordered) if (r.family !== null && !picked.some((p) => p.family === r.family)) picked.push(r);
  return picked.length >= 2 ? (picked as CandidateSet) : null;
}

function mean(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
}

function compareRunners(a: RunnerStats, b: RunnerStats): number {
  return b.winRate - a.winRate || b.runs - a.runs || (a.runner.spec < b.runner.spec ? -1 : a.runner.spec > b.runner.spec ? 1 : 0);
}

function groupBy<T>(items: T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.values()];
}

/**
 * Win rate by task type and runner, outcome counts for the other roles, and a candidate set per task type with at
 * least `minSample` runs: the best runner of each family by win rate, best first. A task type whose runners cover
 * fewer than two known families gets no suggestion; padding with an untried family would be a guess.
 */
export function ledgerStats(rows: LedgerRow[], minSample = DEFAULT_MIN_SAMPLE): LedgerStats {
  const implementers = rows.filter((r): r is Extract<LedgerRow, { role: 'implementer' }> => r.role === 'implementer');
  const byRunner = groupBy(implementers, (r) => `${r.taskType}\t${r.runner.spec}`).map((group): RunnerStats => {
    const outcomes = Object.fromEntries(IMPLEMENTER_OUTCOMES.map((o) => [o, group.filter((r) => r.outcome === o).length])) as Record<ImplementerOutcome, number>;
    return {
      taskType: group[0].taskType, runner: group[0].runner, runs: group.length, wins: outcomes.base, winRate: outcomes.base / group.length, outcomes,
      meanWallTimeMs: mean(group.flatMap((r) => (r.wallTimeMs === null ? [] : [r.wallTimeMs]))),
    };
  }).sort((a, b) => (a.taskType < b.taskType ? -1 : a.taskType > b.taskType ? 1 : compareRunners(a, b)));

  const others = rows.filter((r): r is Exclude<LedgerRow, { role: 'implementer' }> => r.role !== 'implementer');
  const byRole = groupBy(others, (r) => `${r.role}\t${r.runner.spec}`).map((group): RoleStats => {
    const outcomes: Record<string, number> = {};
    for (const r of group) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    return { role: group[0].role, runner: group[0].runner, runs: group.length, outcomes };
  });

  const suggestions: RoutingSuggestion[] = [];
  const withheld: WithheldSuggestion[] = [];
  for (const group of groupBy(implementers, (r) => r.taskType).sort((a, b) => (a[0].taskType < b[0].taskType ? -1 : 1))) {
    const taskType = group[0].taskType;
    const runs = new Set(group.map((r) => r.runId)).size;
    if (runs < minSample) {
      withheld.push({ taskType, runs, reason: `${runs} runs, fewer than the minimum sample of ${minSample}` });
      continue;
    }
    const candidates = crossFamilySet(byRunner.filter((s) => s.taskType === taskType).map((s) => s.runner));
    if (candidates) suggestions.push({ taskType, runs, candidates });
    else withheld.push({ taskType, runs, reason: 'its runners cover fewer than two model families, and a panel stays cross-family' });
  }
  return { minSample, runs: new Set(rows.map((r) => r.runId)).size, byRunner, byRole, suggestions, withheld };
}
