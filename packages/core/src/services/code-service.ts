/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { randomBytes } from 'node:crypto';
import { framedTask, type CodeFrame } from '../domain/code-council/framing.js';
import { classifyTask, PLAYBOOKS, type TaskType, type TaskTypeChoice } from '../domain/code-council/playbooks.js';
import type { Judgment } from '../domain/code-council/judging.js';
import { contends, type CandidateReport, type Ranking } from '../domain/code-council/ranking.js';
import { detectDivergence, type Reframe } from '../domain/code-council/reframe.js';
import type { Graft, Synthesis } from '../domain/code-council/synthesis.js';
import type { PrRequest, PrVerdict } from '../domain/code-council/shipping.js';
import { freezeRubric, parseRubricAnswer, rubricPrompt, type FrozenRubric } from '../domain/code-council/rubric.js';
import { RUBRIC_FILE } from '../domain/code-council/trail.js';
import type { Brief } from '../domain/driver/brief.js';
import type { GateResult } from '../domain/verification/gates.js';
import type { DriverUsage } from '../domain/driver/normalized-event.js';
import type { ReportStatus } from '../domain/driver/report.js';
import { testGate } from '../domain/verification/adversarial.js';
import { getProviderInfo } from '../domain/agent/providers.js';
import { defaultCodeRoles, ROLE_KEYWORDS, specAgent, type CodeRoleMap } from '../domain/roles/roles.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import type { DiffStat, WorkspaceManager } from '../ports/workspace.js';
import { CliCouncilGateway } from '../adapters/cli/cli-council-gateway.js';
import { candidateBranch } from '../adapters/git-worktree-workspace.js';
import { createLogger } from '../shared/logger.js';
import { runAdversarialRound, type AdversarialInput, type AdversarialRound } from './adversarial-service.js';
import { recordDissent, type RunDissent } from './dissent-service.js';
import { rankRun } from './ranking-service.js';
import { reframeRun } from './reframe-service.js';
import { runDriver } from './run-driver.js';
import { skippedSynthesis, synthesize } from './synthesis-service.js';
import { decisions, DecisionTrail, type RunTrail } from './trail-service.js';
import { verifyCandidates, type CandidateVerification, type RunVerification } from './verification-service.js';

const log = createLogger('code');

/** Wall-clock limit for one candidate. */
export const CODE_TIMEOUT_MS = 30 * 60_000;

/** Wall-clock limit for the read-only run that tailors the rubric. */
export const FRAME_TIMEOUT_MS = 5 * 60_000;

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
  /** Gates and integrity checks against the base. Absent when the run was not verified, null when there was no head to check. */
  verification?: CandidateVerification | null;
  /** PASS, ISSUES or BLOCKED from the evidence, with the SHAs it is about. Set once the run is ranked. */
  report?: CandidateReport;
};

/**
 * `reframe-needed`: the candidates diverged, so the run ended with questions and no patch: before synthesis, or after
 * grafting failed to settle a `disjoint-survival` divergence.
 */
export type CodeRunStatus = 'done' | 'reframe-needed';

export type CodeRunRecord = {
  version: 1;
  kind: 'code';
  id: string;
  status: CodeRunStatus;
  /** B8: disagreements kept as output, open ones first in the reports; `path` is `dissent.json` next to them. */
  dissent: RunDissent;
  createdAt: string;
  finishedAt: string;
  task: string;
  repoDir: string;
  /** `HEAD` of the user's checkout when the run started. */
  headSha: string;
  /** What every candidate branched from: `headSha`, or the dirty-tree snapshot on top of it. */
  baseSha: string;
  snapshotRef?: string;
  taskType: TaskTypeChoice;
  /** Who played each role, and where that came from. */
  roles: CodeRoleMap;
  /** Frozen before the first candidate started; every candidate brief holds it. */
  rubric: FrozenRubric;
  candidates: CodeCandidate[];
  /** The gates and the baseline on the base. Absent when the run was not verified. */
  verification?: RunVerification;
  /** Tier 2 adversarial tests and their survival matrix. Absent when not asked for. */
  adversarial?: AdversarialRound;
  /** Evidence first, a judge only for exact ties, and the winner if there is one. */
  ranking: Ranking;
  /** The winner with grafts from the others on the integration branch, and its patch. Absent when not asked for. */
  synthesis?: Synthesis;
  /** Why the candidates diverged and the questions for the task's author. Present only when `status` is `reframe-needed`. */
  reframe?: Reframe;
  /** M6.2: `decisions.tsv` and `events.jsonl` in the run directory, and the trail's commit on the integration branch. Absent when not asked for. */
  trail?: RunTrail;
  /** M7.2: the latest independent verdict on the integration branch (`concilium verify-pr`, `concilium pr`). */
  prVerdict?: PrVerdict;
  /** M7.2: the push and pull request gates `concilium pr` asked for. */
  pr?: PrRequest;
};

export type CodeRunInput = {
  task: string;
  /** Any directory inside the target repo. */
  repoDir: string;
  /** The candidates: the implementer role. */
  agents: CodeAgent[];
  /**
   * Who plays each role (see `runtime.resolveCodeRoles`), recorded on the run. Without it: the first agent plans,
   * one adversary per candidate family, the judge is picked per tie, and the winner integrates.
   */
  roles?: CodeRoleMap;
  /** Without it, `classifyTask` picks one from the task. */
  type?: TaskType;
  includeDirty?: boolean;
  /** The commit the candidates branch from instead of `HEAD`: a factory task's base is the previous task's shipped commit. */
  baseSha?: string;
  timeoutMs?: number;
  /** Defaults to a new id. */
  runId?: string;
  drivers: ReadonlyMap<string, HeadlessCliDriver>;
  workspace: WorkspaceManager;
  signal?: AbortSignal;
  /** After the candidates finish, run the repo's gates on the base and on each candidate, and the integrity checks. */
  verify?: boolean;
  /** After verifying, one adversary per candidate family writes tests, run on the base and every candidate. Needs `verify`. */
  adversarial?: boolean;
  /** Send candidates tied on the evidence to one read-only judge CLI, from another model family when one is usable. */
  judge?: boolean;
  /**
   * After ranking, graft the others' best ideas into the winner on `concilium/<run-id>/integration`, re-verify, and
   * write `result.patch` and `synthesis.md` to `runDir`. When the candidates diverge, write `reframe.md` there instead
   * (for `disjoint-survival` alone, only when grafting does not make the integration head pass the conflicting tests).
   */
  synthesis?: { runDir: string };
  /**
   * Write `decisions.tsv` (one row per orchestrator decision) and `events.jsonl` to `runDir`, append-only. Unless
   * `commit` is false, commit `decisions.tsv`, `dissent.json` and `synthesis.md` as the last commit of the integration
   * branch, under `.concilium/runs/<run-id>/`; `result.patch` does not carry them.
   */
  trail?: { runDir: string; commit?: boolean };
  /** Called once the type is chosen and the rubric frozen, before any candidate starts. */
  onFramed?: (frame: CodeFrame) => void;
  onCandidateStart?: (candidate: { candidateId: string; provider: string; worktree: string }) => void;
  onCandidateDone?: (candidate: CodeCandidate) => void;
  onGateDone?: (lane: string, result: GateResult) => void;
  onAdversaryDone?: AdversarialInput['onAdversaryDone'];
  onTestDone?: AdversarialInput['onTestDone'];
  onJudgeDone?: (judgment: Judgment) => void;
  onGraftDone?: (graft: Graft) => void;
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

/**
 * The write-mode brief a candidate gets: the task with its playbook (never the rubric), its own worktree, read, write and shell.
 * Each driver keeps what its CLI can do safely.
 */
export function codeBrief(task: string, taskType: TaskTypeChoice, worktree: string, branch: string): Brief {
  return {
    version: 1,
    task: framedTask(task, taskType),
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

function agentSpec(agent: CodeAgent): string {
  return agent.model ? `${agent.provider}:${agent.model}` : agent.provider;
}

/** The role map of a run given only its candidates. */
function rolesOf(input: CodeRunInput): CodeRoleMap {
  return input.roles ?? defaultCodeRoles(input.agents.map(agentSpec));
}

/**
 * Asks the planner's CLI, read-only, to tailor the playbook's rubric to the task, and freezes the result.
 * Any failure (no answer, no JSON, a rubric outside 3 to 6 criteria) falls back to the playbook's defaults.
 */
async function frameRubric(input: CodeRunInput, framer: string, type: TaskType, signal: AbortSignal): Promise<FrozenRubric> {
  const playbook = PLAYBOOKS[type];
  if (!framer) return freezeRubric(playbook.rubric, { source: 'playbook', note: 'no agent to tailor the rubric' });
  const gateway = new CliCouncilGateway({ drivers: input.drivers, timeoutMs: FRAME_TIMEOUT_MS });
  const response = await gateway.query(framer, [{ role: 'user', content: rubricPrompt(input.task, playbook) }], undefined, signal);
  if (!response) return freezeRubric(playbook.rubric, { source: 'playbook', framer, note: `${framer} gave no answer` });
  try {
    return freezeRubric(parseRubricAnswer(response.content), { source: 'framer', framer });
  } catch (err) {
    const note = `rubric from ${framer} rejected: ${errorMessage(err)}`;
    log.warn(note);
    return freezeRubric(playbook.rubric, { source: 'playbook', framer, note });
  }
}

/** The input with every progress callback also logged to the trail's `events.jsonl`. */
function traced(input: CodeRunInput, trail: DecisionTrail | null): CodeRunInput {
  if (!trail) return input;
  return {
    ...input,
    onCandidateStart: (c) => {
      trail.event('candidate-start', c);
      input.onCandidateStart?.(c);
    },
    onCandidateDone: (c) => {
      trail.event('candidate-done', { candidateId: c.candidateId, status: c.status, headSha: c.headSha });
      input.onCandidateDone?.(c);
    },
    onGateDone: (lane, r) => {
      trail.event('gate-done', { lane, gate: r.name, outcome: r.outcome, sha: r.sha });
      input.onGateDone?.(lane, r);
    },
    onAdversaryDone: (a) => {
      trail.event('adversary-done', { lane: a.lane, status: a.status, headSha: a.headSha });
      input.onAdversaryDone?.(a);
    },
    onTestDone: (testId, lane, cell) => {
      trail.event('test-done', { testId, lane, cell });
      input.onTestDone?.(testId, lane, cell);
    },
    onJudgeDone: (j) => {
      trail.event('judge-done', { candidates: j.candidates, judge: j.judge, status: j.status });
      input.onJudgeDone?.(j);
    },
    onGraftDone: (g) => {
      trail.event('graft-done', { id: g.id, candidateId: g.candidateId, status: g.status, commitSha: g.commitSha, revertSha: g.revertSha });
      input.onGraftDone?.(g);
    },
  };
}

/** Tier 2 on the candidates with a head, judged under the repo's test gate on the base and on each head. */
function attack(
  input: CodeRunInput, roles: CodeRoleMap, repoDir: string, runId: string, baseSha: string, type: TaskType, verification: RunVerification, candidates: CodeCandidate[], timeoutMs: number, signal: AbortSignal,
): Promise<AdversarialRound> {
  const gate = testGate(verification.plan);
  const testOutcome = (gates: GateResult[] | undefined) => gates?.find((g) => g.name === gate?.name)?.outcome ?? null;
  return runAdversarialRound({
    task: input.task, type, repoDir, runId, baseSha, plan: verification.plan,
    baseTestOutcome: testOutcome(verification.baseline?.gates),
    candidates: candidates.flatMap((c) => (c.worktree && c.headSha ? [{
      candidateId: c.candidateId, provider: c.provider, ...(c.model ? { model: c.model } : {}),
      family: getProviderInfo(c.provider)?.family ?? c.provider, worktree: c.worktree, headSha: c.headSha,
      testOutcome: testOutcome(c.verification?.gates),
    }] : [])),
    ...(Array.isArray(roles.adversary.value) ? {
      adversaries: roles.adversary.value.map((spec) => {
        const agent = specAgent(spec);
        return { ...agent, family: getProviderInfo(agent.provider)?.family ?? agent.provider };
      }),
    } : {}),
    drivers: input.drivers, workspace: input.workspace, timeoutMs, signal,
    onAdversaryDone: input.onAdversaryDone, onTestDone: input.onTestDone,
  });
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
  const roles = rolesOf(input);
  const judgeSpec = roles.judge.value === ROLE_KEYWORDS.judge ? undefined : roles.judge.value;
  const integrator = roles.integrator.value === ROLE_KEYWORDS.integrator ? undefined : specAgent(roles.integrator.value);
  const base = await input.workspace.startRun({ repoDir: input.repoDir, runId, includeDirty: input.includeDirty, baseSha: input.baseSha });
  const repoDir = base.repoDir;
  const trail = input.trail ? new DecisionTrail(input.trail.runDir, { runId, repoDir, baseSha: base.baseSha }) : null;
  const io = traced(input, trail);
  const decide = (d: Parameters<DecisionTrail['decide']>[0]) => trail?.decide(d);
  const file = (path: string | null | undefined) => (trail && path ? trail.relative(path) : null);

  const runCandidate = async (agent: CodeAgent, candidateId: string, taskType: TaskTypeChoice): Promise<CodeCandidate> => {
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
      io.onCandidateStart?.({ candidateId, provider: agent.provider, worktree: workspace.path });
      candidate.brief = codeBrief(input.task, taskType, workspace.path, workspace.branch);

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
    io.onCandidateDone?.(candidate);
    return candidate;
  };

  try {
    // The type and the rubric are fixed before any worktree or candidate exists.
    const taskType: TaskTypeChoice = input.type ? { type: input.type, source: 'flag', reason: 'set with --type' } : classifyTask(input.task);
    const frame: CodeFrame = { taskType, rubric: await frameRubric(input, roles.planner.value, taskType.type, signal) };
    input.onFramed?.(frame);
    log.info(`code run ${runId}: ${taskType.type}, rubric ${frame.rubric.sha256.slice(0, 12)}, ${input.agents.length} candidates from ${base.baseSha}`);
    const ids = candidateIds(input.agents);
    trail?.file(RUBRIC_FILE, `${JSON.stringify(frame.rubric, null, 2)}\n`);
    decide(decisions.taskType(taskType, base.baseSha));
    decide(decisions.rubric(frame.rubric));
    decide(decisions.candidates(ids, roles, base.baseSha));

    const candidates = await Promise.all(input.agents.map((agent, i) => runCandidate(agent, ids[i], taskType)));
    const heads = Object.fromEntries(candidates.map((c) => [c.candidateId, c.headSha]));

    let verification: RunVerification | undefined;
    if (input.verify) {
      const checkable = candidates.flatMap((c) => (c.worktree && c.headSha ? [{ candidateId: c.candidateId, worktree: c.worktree, headSha: c.headSha }] : []));
      const result = await verifyCandidates({
        repoDir, runId, baseSha: base.baseSha, candidates: checkable, workspace: input.workspace, signal, onGateDone: io.onGateDone,
      });
      verification = result.run;
      for (const c of candidates) c.verification = result.candidates.get(c.candidateId) ?? null;
      decide(decisions.gatePlan(verification, base.baseSha));
      for (const c of candidates) decide(decisions.verification(c.candidateId, c.verification ?? null, base.baseSha));
    }

    let adversarial: AdversarialRound | undefined;
    if (input.adversarial) {
      adversarial = verification
        ? await attack(io, roles, repoDir, runId, base.baseSha, taskType.type, verification, candidates, timeoutMs, signal)
        : { skipped: 'the gates did not run', testCommand: null, adversaries: [], tests: [], matrix: {}, survival: {}, runs: [] };
      decide(decisions.adversarial(adversarial, base.baseSha));
    }

    const ranking = await rankRun({
      task: input.task, repoDir, baseSha: base.baseSha, type: taskType.type, rubric: frame.rubric, candidates, adversarial,
      judge: input.judge ?? false, judgeSpec, drivers: input.drivers, signal, onJudgeDone: io.onJudgeDone,
    });
    log.info(`code run ${runId}: winner ${ranking.winner ?? 'none'} (${ranking.reason})`);
    for (const j of ranking.judgments) decide(decisions.judgment(j, heads, base.baseSha));
    decide(decisions.ranking(ranking, heads, base.baseSha));

    // Divergence means the task may be underspecified. A prototype ends in a decision record anyway.
    const divergence = input.synthesis && taskType.type !== 'prototype'
      ? detectDivergence({
        candidates: ranking.order.map((e) => {
          const c = candidates.find((c) => c.candidateId === e.candidateId)!;
          return { candidateId: e.candidateId, family: getProviderInfo(c.provider)?.family ?? c.provider, contends: contends(e), newFailures: c.verification?.newFailures ?? [] };
        }),
        tests: adversarial?.tests ?? [], matrix: adversarial?.matrix ?? {}, judgments: ranking.judgments,
      })
      : [];
    // Complementary misses (only `disjoint-survival`) may be grafted together: synthesis runs first, and the run asks
    // only when the integration head still fails a gate or a conflicting test. Any other trigger asks at once.
    const graftFirst = divergence.length > 0 && divergence.every((d) => d.trigger === 'disjoint-survival');
    const asks = (runDir: string, grafting?: Reframe['grafting']) => reframeRun({
      task: input.task, repoDir, runId, baseSha: base.baseSha, runDir, framer: roles.planner.value ? specAgent(roles.planner.value) : undefined, divergence, grafting,
      candidates: candidates.filter((c) => c.headSha && c.report?.status !== 'BLOCKED'), drivers: input.drivers, timeoutMs: FRAME_TIMEOUT_MS, signal,
    });
    let synthesis: Synthesis | undefined;
    let reframe: Reframe | undefined;
    if (input.synthesis && divergence.length > 0 && !graftFirst) {
      reframe = await asks(input.synthesis.runDir);
      synthesis = skippedSynthesis(`the candidates diverge (${divergence.map((d) => d.trigger).join(', ')}), so the task needs a reframe`);
    } else if (input.synthesis) {
      const conflicts = new Set(divergence.flatMap((d) => d.tests ?? []));
      synthesis = await synthesize({
        task: input.task, type: taskType.type, repoDir, runId, baseSha: base.baseSha, runDir: input.synthesis.runDir, candidates, ranking,
        verification, adversarial, drivers: input.drivers, workspace: input.workspace, pickerSpec: judgeSpec, integrator, timeoutMs, signal, onGraftDone: io.onGraftDone,
        ...(graftFirst ? { conflictTests: [...conflicts].map((id) => adversarial!.tests.find((t) => t.id === id)!) } : {}),
      });
      if (graftFirst && !synthesis.divergence?.resolved) {
        reframe = await asks(input.synthesis.runDir, {
          branch: synthesis.branch, headSha: synthesis.headSha,
          applied: synthesis.grafts.filter((g) => g.status === 'applied').length, rejected: synthesis.grafts.filter((g) => g.status === 'rejected').length,
          outcome: synthesis.divergence?.reason ?? synthesis.skipped ?? synthesis.notes.at(-1) ?? 'synthesis did not finish',
          synthesisPath: synthesis.synthesisPath,
        });
      }
    }
    if (synthesis) {
      decide(decisions.basePick(synthesis, ranking, base.baseSha, file(synthesis.synthesisPath)));
      for (const g of synthesis.grafts) decide(decisions.graft(g, synthesis.base?.headSha ?? base.baseSha));
    }
    if (input.synthesis) decide(decisions.divergence(divergence, synthesis, reframe, base.baseSha, file(reframe?.reportPath ?? synthesis?.synthesisPath)));
    const recorded = await recordDissent({
      run: { id: runId, task: input.task, baseSha: base.baseSha }, ranking, synthesis, reframe, heads, tests: adversarial?.tests ?? [],
    });
    synthesis = recorded.synthesis;
    decide(decisions.dissent(recorded.dissent.records, base.baseSha, file(recorded.dissent.path)));
    if (synthesis) decide(decisions.mergeable(synthesis, base.baseSha, file(synthesis.patchPath)));

    let runTrail: RunTrail | undefined;
    if (trail) {
      // The trail ships with the change: its last commit on the integration branch, after result.patch was cut.
      const commitSha = input.trail?.commit !== false && synthesis?.branch ? await trail.commit({ workspace: input.workspace, repoDir, runId }) : null;
      await trail.flush();
      runTrail = { decisionsPath: trail.decisionsPath, eventsPath: trail.eventsPath, rows: trail.rows, commitSha, errors: trail.errors };
    }
    return {
      version: 1,
      kind: 'code',
      id: runId,
      status: reframe ? 'reframe-needed' : 'done',
      dissent: recorded.dissent,
      createdAt,
      finishedAt: new Date().toISOString(),
      task: input.task,
      repoDir,
      headSha: base.headSha,
      baseSha: base.baseSha,
      ...(base.snapshotRef ? { snapshotRef: base.snapshotRef } : {}),
      taskType,
      roles,
      rubric: frame.rubric,
      candidates,
      ...(verification ? { verification } : {}),
      ...(adversarial ? { adversarial } : {}),
      ranking,
      ...(synthesis ? { synthesis } : {}),
      ...(reframe ? { reframe } : {}),
      ...(runTrail ? { trail: runTrail } : {}),
    };
  } finally {
    await trail?.flush();
    await input.workspace.finishRun({ repoDir, runId });
  }
}
