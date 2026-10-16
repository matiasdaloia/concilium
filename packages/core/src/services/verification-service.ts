/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { judgeGates, type GatePlan, type GateResult, type GateVerdict, type StepResult } from '../domain/verification/gates.js';
import type { IntegrityFinding } from '../domain/verification/integrity.js';
import type { WorkspaceManager } from '../ports/workspace.js';
import { GateRunner, type LaneResult } from '../adapters/gate-runner.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('verify');

/** The scratch worktree that holds the run's base, for the baseline. */
export const BASE_LANE = 'base';

/** One candidate checked against the base. `ISSUES` when a gate newly fails, a check flags it, or verifying failed. */
export type CandidateVerification = {
  status: 'PASS' | 'ISSUES';
  /** The head the gates ran at. */
  sha: string | null;
  install: StepResult | null;
  gates: GateVerdict[];
  /** Names of the gates that fail here and pass on the base. */
  newFailures: string[];
  integrity: IntegrityFinding[];
  /** It weakened the tests. */
  disqualified: boolean;
  /** Integrity findings that are penalties, not disqualifications. */
  penalties: number;
  errors: string[];
};

/** What every candidate was checked against. */
export type RunVerification = {
  plan: GatePlan;
  /** The gates on the base, or null when the base could not be checked out. */
  baseline: LaneResult | null;
  errors: string[];
};

export type VerifyInput = {
  repoDir: string;
  runId: string;
  baseSha: string;
  /** Candidates with a worktree checked out at their head. */
  candidates: { candidateId: string; worktree: string; headSha: string }[];
  workspace: WorkspaceManager;
  runner?: GateRunner;
  signal?: AbortSignal;
  onGateDone?: (lane: string, result: GateResult) => void;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function judgeCandidate(baseline: LaneResult | null, lane: LaneResult | null, integrity: IntegrityFinding[], errors: string[]): CandidateVerification {
  const gates = lane ? judgeGates(baseline?.gates ?? [], lane.gates) : [];
  const newFailures = gates.filter((g) => g.verdict === 'new-failure').map((g) => g.name);
  const disqualified = integrity.some((f) => f.severity === 'disqualify');
  const penalties = integrity.filter((f) => f.severity === 'penalty').length;
  const clean = newFailures.length === 0 && integrity.length === 0 && errors.length === 0 && lane !== null;
  return { status: clean ? 'PASS' : 'ISSUES', sha: lane?.sha ?? null, install: lane?.install ?? null, gates, newFailures, integrity, disqualified, penalties, errors };
}

/**
 * Checks out the base in a scratch worktree, decides the gates from it, and runs them there once for the baseline.
 * Then, one candidate at a time, runs the same gates at the candidate's head and the integrity checks on its diff.
 * Gates run one after another so that tests sharing ports or files do not collide.
 */
export async function verifyCandidates(input: VerifyInput): Promise<{ run: RunVerification; candidates: Map<string, CandidateVerification> }> {
  const runner = input.runner ?? new GateRunner();
  const errors: string[] = [];
  const candidates = new Map<string, CandidateVerification>();
  const onGate = (lane: string) => (result: GateResult) => input.onGateDone?.(lane, result);

  let plan: GatePlan = { source: 'detected', gates: [], install: null, notes: [] };
  let baseline: LaneResult | null = null;
  try {
    const base = await input.workspace.create({ repoDir: input.repoDir, runId: input.runId, candidateId: BASE_LANE });
    plan = runner.plan(base.path);
    baseline = await runner.runLane(BASE_LANE, base.path, plan, { signal: input.signal, onGate: onGate(BASE_LANE) });
  } catch (err) {
    errors.push(`baseline: ${errorMessage(err)}`);
  }
  log.info(`run ${input.runId}: ${plan.gates.length} gates (${plan.source}) on ${input.candidates.length} candidates`);

  for (const candidate of input.candidates) {
    const candidateErrors = baseline ? [] : ['no baseline: the base could not be checked'];
    let lane: LaneResult | null = null;
    let integrity: IntegrityFinding[] = [];
    try {
      integrity = await runner.integrity(input.repoDir, input.baseSha, candidate.headSha);
    } catch (err) {
      candidateErrors.push(`integrity: ${errorMessage(err)}`);
    }
    try {
      lane = await runner.runLane(candidate.candidateId, candidate.worktree, plan, { signal: input.signal, onGate: onGate(candidate.candidateId) });
    } catch (err) {
      candidateErrors.push(`gates: ${errorMessage(err)}`);
    }
    candidates.set(candidate.candidateId, judgeCandidate(baseline, lane, integrity, candidateErrors));
  }
  return { run: { plan, baseline, errors }, candidates };
}
