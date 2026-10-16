/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { specFamily } from '../roles/roles.js';
import { jsonFromAnswer, type FrozenRubric } from './rubric.js';

/** Scores run from 0 (misses the criterion) to this. */
export const MAX_SCORE = 10;

/** One judge score, after the blind label is mapped back to the candidate. */
export type JudgeScore = { candidateId: string; criterion: string; score: number; reason: string };

/**
 * One judge run on one group of candidates tied on the evidence. Only a `PASS` judgment orders them.
 * `BLOCKED`: the rubric no longer matches its frozen hash, no CLI could judge, or the answer was rejected.
 */
export type Judgment = {
  status: 'PASS' | 'BLOCKED';
  /** The tied candidates, in the order they were labelled A, B, ... */
  candidates: string[];
  /** The CLI that judged: a configured `cli[:model]`, or a picked CLI on its own default model. */
  judge: string | null;
  /** The judge is not known to be of another family than the tied candidates: allowed only when no such CLI is usable. */
  sameFamily: boolean;
  /** Why a same-family judge was picked; null otherwise. */
  sameFamilyReason: string | null;
  /** The frozen rubric's hash, checked before the judge ran. */
  rubricSha256: string;
  scores: JudgeScore[];
  /** Per candidate, the sum of weight × score over the criteria. */
  totals: Record<string, number>;
  reason: string;
};

export type JudgeChoice = { provider: string; sameFamily: boolean; sameFamilyReason: string | null };

/**
 * The first usable CLI whose family wrote none of the tied candidates. Without one, the first usable CLI, flagged
 * `sameFamily` with the reason; a CLI of unknown family (OpenCode) never counts as another family. Null when no CLI is usable.
 */
export function pickJudge(tiedFamilies: string[], usable: { provider: string; family: string | null }[]): JudgeChoice | null {
  const other = usable.find((u) => u.family !== null && !tiedFamilies.includes(u.family));
  if (other) return { provider: other.provider, sameFamily: false, sameFamilyReason: null };
  const first = usable[0];
  if (!first) return null;
  return { provider: first.provider, sameFamily: true, sameFamilyReason: `no CLI outside the tied families (${tiedFamilies.join(', ')}) is usable, so ${first.provider} judges` };
}

/**
 * A judge set in the role config. It is always used; like a picked one, it is flagged `sameFamily` when its family
 * wrote one of `families` or is unknown.
 */
export function configuredJudge(spec: string, families: string[]): JudgeChoice {
  const family = specFamily(spec);
  if (family !== null && !families.includes(family)) return { provider: spec, sameFamily: false, sameFamilyReason: null };
  return {
    provider: spec,
    sameFamily: true,
    sameFamilyReason: family === null
      ? `the configured judge ${spec} is of an unknown family`
      : `the configured judge ${spec} is of one of the families it reads (${families.join(', ')})`,
  };
}

/** What a judge sees of one candidate: a letter, its diff against the base and its evidence, never who wrote it. */
export type JudgePack = { label: string; diff: string; evidence: string[] };

/** The prompt for a judge of tied candidates. No example ordering: the format names fields, not candidates. */
export function judgePrompt(task: string, rubric: FrozenRubric, packs: JudgePack[]): string {
  return [
    `You are judging ${packs.length} candidate solutions to the coding task below, written independently by agents you do not know.`,
    'They tie on the evidence (the gates, the integrity checks and the adversarial tests), so your scores decide only their order among themselves.',
    `Score every candidate on every criterion of the rubric, from 0 (misses it) to ${MAX_SCORE} (fully meets it), with a one-line reason that points at the diff or the evidence.`,
    '',
    `Task:\n${task}`,
    '',
    `Rubric (sha256 ${rubric.sha256}):\n${JSON.stringify(rubric.criteria, null, 2)}`,
    ...packs.flatMap((p) => [
      '',
      `## Candidate ${p.label}`,
      'Evidence:',
      ...(p.evidence.length ? p.evidence.map((e) => `- ${e}`) : ['- none']),
      'Diff against the base:',
      '```diff',
      p.diff.trimEnd(),
      '```',
    ]),
    '',
    'Do not change any files. Reply with only a JSON object holding one entry per candidate and criterion:',
    `{"scores": [{"candidate": "<candidate letter>", "criterion": "<criterion name>", "score": <0 to ${MAX_SCORE}>, "reason": "<one line>"}]}`,
  ].join('\n');
}

export class JudgeValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid judgment: ${problems.join('; ')}`);
    this.name = 'JudgeValidationError';
  }
}

/** Reads a judge's answer: exactly one score per label and criterion, each 0 to `MAX_SCORE` with a reason. Throws naming every problem. */
export function parseJudgeAnswer(text: string, labels: string[], criteria: string[]): { label: string; criterion: string; score: number; reason: string }[] {
  let parsed: unknown;
  try {
    parsed = jsonFromAnswer(text);
  } catch (err) {
    throw new JudgeValidationError([`answer: ${(err as Error).message}`]);
  }
  const entries = (parsed as { scores?: unknown } | null)?.scores;
  if (!Array.isArray(entries)) throw new JudgeValidationError(['answer: has no "scores" list']);

  const problems: string[] = [];
  const scores: { label: string; criterion: string; score: number; reason: string }[] = [];
  const seen = new Set<string>();
  entries.forEach((entry: unknown, i) => {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const label = typeof e.candidate === 'string' ? e.candidate.trim().replace(/^candidate\s+/i, '') : '';
    const criterion = typeof e.criterion === 'string' ? e.criterion.trim() : '';
    const before = problems.length;
    if (!labels.includes(label)) problems.push(`scores[${i}].candidate: must be one of ${labels.join(', ')}`);
    if (!criteria.includes(criterion)) problems.push(`scores[${i}].criterion: must be one of ${criteria.join(', ')}`);
    if (typeof e.score !== 'number' || !Number.isFinite(e.score) || e.score < 0 || e.score > MAX_SCORE) problems.push(`scores[${i}].score: must be a number from 0 to ${MAX_SCORE}`);
    if (typeof e.reason !== 'string' || !e.reason.trim()) problems.push(`scores[${i}].reason: must be a non-empty string`);
    if (problems.length > before) return;
    const key = `${label}\u0000${criterion}`;
    if (seen.has(key)) problems.push(`scores[${i}]: candidate ${label} is scored on ${criterion} twice`);
    seen.add(key);
    scores.push({ label, criterion, score: e.score as number, reason: (e.reason as string).trim() });
  });
  for (const label of labels) {
    for (const criterion of criteria) {
      if (!seen.has(`${label}\u0000${criterion}`)) problems.push(`candidate ${label} has no score for ${criterion}`);
    }
  }
  if (problems.length > 0) throw new JudgeValidationError(problems);
  return scores;
}
