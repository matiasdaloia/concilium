/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  completeQuestions,
  parseReframeAnswer,
  REFRAME_REPORT,
  reframeMarkdown,
  reframePrompt,
  type Divergence,
  type Reframe,
  type ReframeGrafting,
  type SpecQuestion,
} from '../domain/code-council/reframe.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import { CliCouncilGateway } from '../adapters/cli/cli-council-gateway.js';
import { GateRunner } from '../adapters/gate-runner.js';
import { createLogger } from '../shared/logger.js';
import type { CodeAgent, CodeCandidate } from './code-service.js';
import { JUDGE_DIFF_LIMIT } from './ranking-service.js';

const log = createLogger('reframe');

export type ReframeInput = {
  task: string;
  repoDir: string;
  runId: string;
  baseSha: string;
  /** Where `reframe.md` is written. */
  runDir: string;
  /** The CLI and model that framed the run; it phrases the questions, read-only. */
  framer?: CodeAgent;
  divergence: Divergence[];
  /** What grafting left, when it was tried first. */
  grafting?: ReframeGrafting;
  /** The candidates whose diffs the phraser reads. */
  candidates: CodeCandidate[];
  drivers: ReadonlyMap<string, HeadlessCliDriver>;
  timeoutMs: number;
  runner?: GateRunner;
  signal?: AbortSignal;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Asks the framer's CLI for the questions; returns none, with a note, when it gives no usable answer. */
async function phrase(input: ReframeInput, framer: string, notes: string[]): Promise<SpecQuestion[]> {
  const runner = input.runner ?? new GateRunner();
  const packs = await Promise.all(input.candidates.filter((c) => c.headSha).map(async (c) => {
    const diff = await runner.diff(input.repoDir, input.baseSha, c.headSha!);
    return { candidateId: c.candidateId, diff: diff.length > JUDGE_DIFF_LIMIT ? `${diff.slice(0, JUDGE_DIFF_LIMIT)}\n... (diff truncated at ${JUDGE_DIFF_LIMIT} characters)` : diff };
  }));
  const gateway = new CliCouncilGateway({ drivers: input.drivers, timeoutMs: input.timeoutMs });
  const response = await gateway.query(framer, [{ role: 'user', content: reframePrompt(input.task, input.divergence, packs) }], undefined, input.signal);
  if (!response) {
    notes.push(`${framer} gave no answer, so the questions were written from the evidence`);
    return [];
  }
  try {
    const parsed = parseReframeAnswer(response.content, input.divergence.flatMap((d) => d.conflicts.map((c) => c.clause)));
    notes.push(...parsed.notes);
    return parsed.questions;
  } catch (err) {
    notes.push(`${errorMessage(err)}, so the questions were written from the evidence`);
    return [];
  }
}

/**
 * M5.2. The candidates diverged, so nothing is blended: one read-only run of the framer's CLI turns the lines in
 * conflict into questions for the task's author, every line it leaves out gets a question written from the
 * evidence, and the result goes to `reframe.md` in the run directory.
 */
export async function reframeRun(input: ReframeInput): Promise<Reframe> {
  const notes: string[] = [];
  const framer = input.framer ? (input.framer.model ? `${input.framer.provider}:${input.framer.model}` : input.framer.provider) : null;
  if (!framer) notes.push('no agent to phrase the questions');
  const phrased = framer ? await phrase(input, framer, notes) : [];
  const questions = completeQuestions(input.divergence, phrased);
  const fellBack = questions.filter((q) => !phrased.includes(q)).map((q) => q.clause);
  if (phrased.length && fellBack.length) notes.push(`written from the evidence for ${fellBack.map((c) => `"${c}"`).join(', ')}, which ${framer} left out`);

  const reframe: Reframe = {
    divergence: input.divergence, questions, phraser: framer, source: phrased.length ? 'phraser' : 'fallback', notes, reportPath: null,
    ...(input.grafting ? { grafting: input.grafting } : {}),
  };
  try {
    await mkdir(input.runDir, { recursive: true });
    const path = join(input.runDir, REFRAME_REPORT);
    await writeFile(path, reframeMarkdown(reframe, { id: input.runId, task: input.task, baseSha: input.baseSha }));
    reframe.reportPath = path;
  } catch (err) {
    notes.push(`could not write ${REFRAME_REPORT}: ${errorMessage(err)}`);
  }
  log.info(`run ${input.runId}: reframe needed (${input.divergence.map((d) => d.trigger).join(', ')}), ${questions.length} questions from ${reframe.source}`);
  return reframe;
}
