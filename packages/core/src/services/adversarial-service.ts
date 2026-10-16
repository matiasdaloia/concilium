/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TaskType } from '../domain/code-council/playbooks.js';
import type { Brief } from '../domain/driver/brief.js';
import type { DriverUsage } from '../domain/driver/normalized-event.js';
import type { ReportStatus } from '../domain/driver/report.js';
import {
  ADVERSARIAL_MANIFEST,
  adversaryBrief,
  classifyTest,
  parseAdversarialManifest,
  survival,
  testGate,
  type AdversarialTest,
  type AdversarialTestSpec,
  type Survival,
  type SurvivalCell,
  type SurvivalMatrix,
} from '../domain/verification/adversarial.js';
import type { GatePlan, StepResult } from '../domain/verification/gates.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import type { WorkspaceManager } from '../ports/workspace.js';
import { GateRunner } from '../adapters/gate-runner.js';
import { candidateBranch } from '../adapters/git-worktree-workspace.js';
import { createLogger } from '../shared/logger.js';
import { runDriver } from './run-driver.js';
import { BASE_LANE } from './verification-service.js';

const log = createLogger('adversarial');

/** One adversary: a fresh run of the first candidate's CLI of its family, in its own scratch worktree from the base. */
export type Adversary = {
  family: string;
  provider: string;
  model: string | null;
  /** Its worktree and branch id: `adv-<family>`. */
  lane: string;
  branch: string;
  worktree: string;
  /** Its branch head after the commit, holding its tests. */
  headSha: string | null;
  status: ReportStatus;
  durationMs: number;
  usage: DriverUsage | null;
  errors: string[];
  /** Manifest entries it dropped. */
  notes: string[];
  /** The candidates whose diffs it was given. */
  peers: string[];
  brief: Brief | null;
  finalText: string;
};

/** One adversarial test run in one lane. */
export type AdversarialRun = StepResult & { testId: string; lane: string };

/** Tier 2: the adversaries, their tests, the survival matrix and what counts for each candidate. */
export type AdversarialRound = {
  /** Why the round did not run. */
  skipped?: string;
  /** The repo's test gate command every test runs under. */
  testCommand: string | null;
  adversaries: Adversary[];
  tests: AdversarialTest[];
  matrix: SurvivalMatrix;
  survival: Record<string, Survival>;
  /** Every test run, with its output; a lane whose own suite does not pass is not run, and its cell is `error`. */
  runs: AdversarialRun[];
};

export type AdversarialCandidate = {
  candidateId: string;
  provider: string;
  model?: string;
  /** The model family of its CLI (the provider id when the CLI has none). */
  family: string;
  worktree: string;
  headSha: string;
  /** Its test gate's outcome without the adversarial tests. */
  testOutcome: StepResult['outcome'] | null;
};

export type AdversarialInput = {
  task: string;
  type: TaskType;
  repoDir: string;
  runId: string;
  baseSha: string;
  plan: GatePlan;
  /** The base's test gate outcome without the adversarial tests. */
  baseTestOutcome: StepResult['outcome'] | null;
  candidates: AdversarialCandidate[];
  drivers: ReadonlyMap<string, HeadlessCliDriver>;
  workspace: WorkspaceManager;
  /** Wall-clock limit per adversary. */
  timeoutMs: number;
  runner?: GateRunner;
  signal?: AbortSignal;
  onAdversaryDone?: (adversary: Adversary) => void;
  onTestDone?: (testId: string, lane: string, cell: SurvivalCell) => void;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Writes `content` at `rel` in `dir` and returns how to put back what was there. */
function place(dir: string, rel: string, content: Buffer): () => void {
  const target = join(dir, rel);
  const before = existsSync(target) ? readFileSync(target) : null;
  let created: string | null = null;
  for (let parent = dirname(target); !existsSync(parent); parent = dirname(parent)) created = parent;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return () => {
    if (before) writeFileSync(target, before);
    else rmSync(created ?? target, { recursive: true, force: true });
  };
}

async function runAdversary(
  input: AdversarialInput, family: string, author: AdversarialCandidate, patches: { candidateId: string; path: string }[], testCommand: string, signal: AbortSignal,
): Promise<{ adversary: Adversary; specs: AdversarialTestSpec[] }> {
  const lane = `adv-${family}`;
  const adversary: Adversary = {
    family, provider: author.provider, model: author.model || null, lane, branch: candidateBranch(input.runId, lane), worktree: '', headSha: null,
    status: 'error', durationMs: 0, usage: null, errors: [], notes: [], peers: patches.map((p) => p.candidateId), brief: null, finalText: '',
  };
  let specs: AdversarialTestSpec[] = [];
  const startedAt = Date.now();
  try {
    const workspace = await input.workspace.create({ repoDir: input.repoDir, runId: input.runId, candidateId: lane });
    adversary.worktree = workspace.path;
    adversary.brief = adversaryBrief({ task: input.task, type: input.type, worktree: workspace.path, testCommand, patches: patches.map((p) => p.path) });
    const driver = input.drivers.get(author.provider);
    if (!driver) throw new Error(`No agent CLI driver for "${author.provider}"`);
    const report = await runDriver(driver, adversary.brief, author.model || undefined, input.timeoutMs, signal);
    adversary.status = report.status;
    adversary.usage = report.usage;
    adversary.errors.push(...report.errors);
    adversary.finalText = report.finalText;

    const manifest = join(workspace.path, ADVERSARIAL_MANIFEST);
    if (!existsSync(manifest)) throw new Error(`wrote no ${ADVERSARIAL_MANIFEST}`);
    const isFile = (rel: string) => existsSync(join(workspace.path, rel)) && statSync(join(workspace.path, rel)).isFile();
    const parsed = parseAdversarialManifest(readFileSync(manifest, 'utf8'), isFile);
    specs = parsed.tests;
    adversary.notes.push(...parsed.notes);
  } catch (err) {
    adversary.status = 'error';
    adversary.errors.push(errorMessage(err));
  }
  adversary.durationMs = Date.now() - startedAt;

  // Its tests go on its branch, so the evidence can be read later.
  if (adversary.worktree) {
    try {
      const message = `concilium: ${lane} adversarial tests for run ${input.runId}\n\nAgent: ${author.provider}\nStatus: ${adversary.status}\n`;
      adversary.headSha = (await input.workspace.commit({ repoDir: input.repoDir, runId: input.runId, candidateId: lane, message })).headSha;
    } catch (err) {
      adversary.errors.push(errorMessage(err));
    }
  }
  log.info(`run ${input.runId}: ${lane} ${adversary.status}, ${specs.length} tests`);
  input.onAdversaryDone?.(adversary);
  return { adversary, specs };
}

/**
 * Tier 2. One adversary per candidate family writes tests aimed at the task and at the other families' diffs.
 * Each test then runs, under the repo's test gate, on the base and on every candidate: its files are copied into
 * the lane's worktree for the run and removed after, so no branch changes. The validity rule decides what counts.
 */
export async function runAdversarialRound(input: AdversarialInput): Promise<AdversarialRound> {
  const skip = (skipped: string): AdversarialRound => ({ skipped, testCommand: null, adversaries: [], tests: [], matrix: {}, survival: {}, runs: [] });
  if (input.candidates.length < 2) return skip('fewer than 2 candidates');
  const gate = testGate(input.plan);
  if (!gate) return skip('no test gate to run the tests with');

  const runner = input.runner ?? new GateRunner();
  const signal = input.signal ?? new AbortController().signal;
  const authors = new Map<string, AdversarialCandidate>();
  for (const c of input.candidates) if (!authors.has(c.family)) authors.set(c.family, c);

  // Peers' diffs are files outside every worktree, labelled by position, not by agent.
  const patchDir = await mkdtemp(join(tmpdir(), 'concilium-adversary-'));
  let results: { adversary: Adversary; specs: AdversarialTestSpec[] }[];
  try {
    const patches: { candidateId: string; family: string; path: string }[] = [];
    for (const [i, c] of input.candidates.entries()) {
      const path = join(patchDir, `candidate-${i + 1}.patch`);
      await writeFile(path, await runner.diff(input.repoDir, input.baseSha, c.headSha));
      patches.push({ candidateId: c.candidateId, family: c.family, path });
    }
    results = await Promise.all([...authors].map(([family, author]) =>
      runAdversary(input, family, author, patches.filter((p) => p.family !== family), gate.command, signal)));
  } finally {
    await rm(patchDir, { recursive: true, force: true });
  }

  const base = await input.workspace.create({ repoDir: input.repoDir, runId: input.runId, candidateId: BASE_LANE });
  const lanes = [
    { lane: BASE_LANE, dir: base.path, sha: input.baseSha, ready: input.baseTestOutcome === 'pass' },
    ...input.candidates.map((c) => ({ lane: c.candidateId, dir: c.worktree, sha: c.headSha, ready: c.testOutcome === 'pass' })),
  ];
  const tests: AdversarialTest[] = [];
  const matrix: SurvivalMatrix = {};
  const runs: AdversarialRun[] = [];
  for (const { adversary, specs } of results) {
    for (const [i, spec] of specs.entries()) {
      const id = `${adversary.family}-${i + 1}`;
      const contents = spec.files.map((file) => readFileSync(join(adversary.worktree, file)));
      matrix[id] = {};
      for (const lane of lanes) {
        let cell: SurvivalCell = 'error';
        if (lane.ready) {
          const restore = spec.files.map((file, f) => place(lane.dir, file, contents[f]));
          try {
            const run = await runner.runStep(gate.name, gate.command, lane.dir, lane.sha, gate.timeoutMs, signal);
            runs.push({ ...run, testId: id, lane: lane.lane });
            cell = run.outcome === 'pass' || run.outcome === 'fail' ? run.outcome : 'error';
          } finally {
            for (const undo of restore.reverse()) undo();
          }
        }
        matrix[id][lane.lane] = cell;
        input.onTestDone?.(id, lane.lane, cell);
      }
      const cells = input.candidates.map((c) => ({ family: c.family, cell: matrix[id][c.candidateId] }));
      const validity = classifyTest(matrix[id][BASE_LANE], cells, adversary.family, input.type);
      tests.push({ id, author: adversary.family, ...spec, validity });
    }
  }
  return {
    testCommand: gate.command,
    adversaries: results.map((r) => r.adversary),
    tests,
    matrix,
    survival: survival(tests, matrix, input.candidates),
    runs,
  };
}
