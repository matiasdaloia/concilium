/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { createHash } from 'node:crypto';
import type { Playbook } from './playbooks.js';

/** What settles a criterion: a command (tests, a benchmark), tests written by other candidates, or a reviewer. */
export const RUBRIC_EVIDENCE = ['gate', 'adversarial', 'judgment'] as const;
export type RubricEvidence = (typeof RUBRIC_EVIDENCE)[number];

export type RubricCriterion = { name: string; description: string; weight: number; evidence: RubricEvidence };

export const MIN_CRITERIA = 3;
export const MAX_CRITERIA = 6;

/** The rubric candidates are judged on, fixed before any candidate starts. `sha256` lets later phases prove it did not change. */
export type FrozenRubric = {
  criteria: RubricCriterion[];
  /** `framer`: tailored to the task by one read-only CLI run. `playbook`: the type's defaults. */
  source: 'framer' | 'playbook';
  /** The CLI that tailored it, or tried to. */
  framer?: string;
  /** Why the playbook defaults were used. */
  note?: string;
  frozenAt: string;
  sha256: string;
};

export class RubricValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid rubric: ${problems.join('; ')}`);
    this.name = 'RubricValidationError';
  }
}

/** Checks an untrusted value (e.g. a framer's JSON) and returns its criteria, or throws naming every problem. */
export function parseRubricCriteria(value: unknown): RubricCriterion[] {
  if (!Array.isArray(value)) throw new RubricValidationError(['criteria: must be an array']);
  const problems: string[] = [];
  if (value.length < MIN_CRITERIA || value.length > MAX_CRITERIA) {
    problems.push(`criteria: must hold ${MIN_CRITERIA} to ${MAX_CRITERIA} criteria, got ${value.length}`);
  }
  const names = new Set<string>();
  value.forEach((item: unknown, i) => {
    const c = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof c.name !== 'string' || !c.name.trim()) problems.push(`criteria[${i}].name: must be a non-empty string`);
    else if (names.has(c.name)) problems.push(`criteria[${i}].name: "${c.name}" is used twice`);
    else names.add(c.name);
    if (typeof c.description !== 'string' || !c.description.trim()) problems.push(`criteria[${i}].description: must be a non-empty string`);
    if (typeof c.weight !== 'number' || !Number.isFinite(c.weight) || c.weight <= 0) problems.push(`criteria[${i}].weight: must be a positive number`);
    if (!RUBRIC_EVIDENCE.includes(c.evidence as RubricEvidence)) problems.push(`criteria[${i}].evidence: must be one of ${RUBRIC_EVIDENCE.join(', ')}`);
  });
  if (problems.length > 0) throw new RubricValidationError(problems);
  return value.map((c: RubricCriterion) => ({ name: c.name, description: c.description, weight: c.weight, evidence: c.evidence }));
}

/** sha256 of the criteria with their fields in a fixed order. */
export function rubricHash(criteria: RubricCriterion[]): string {
  const canonical = criteria.map(({ name, description, weight, evidence }) => ({ name, description, weight, evidence }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function freezeRubric(
  criteria: RubricCriterion[],
  origin: Pick<FrozenRubric, 'source' | 'framer' | 'note'>,
  now = new Date(),
): FrozenRubric {
  const checked = parseRubricCriteria(criteria);
  return { criteria: checked, ...origin, frozenAt: now.toISOString(), sha256: rubricHash(checked) };
}

/** The prompt for the one read-only CLI run that tailors the playbook's rubric to the task. */
export function rubricPrompt(task: string, playbook: Playbook): string {
  return [
    `Several coding agents will each attempt the ${playbook.type} task below, independently. Write the rubric their work will be judged on.`,
    `Start from the default criteria for a ${playbook.type} task and tailor them to this task. Keep ${MIN_CRITERIA} to ${MAX_CRITERIA} criteria, each one gradeable. Each criterion has:`,
    '- name: short kebab-case id, unique',
    '- description: one sentence a grader can check',
    '- weight: a positive number, larger for what matters more',
    '- evidence: "gate" (a command such as the tests or a benchmark settles it), "adversarial" (tests written by the other agents settle it) or "judgment" (a reviewer reading the diff decides)',
    '',
    'Do not attempt the task and do not write any files. Reply with only a JSON object: {"criteria": [...]}.',
    '',
    `Default criteria:\n${JSON.stringify(playbook.rubric, null, 2)}`,
    '',
    `Task:\n${task}`,
  ].join('\n');
}

/** The JSON object or array in a CLI's answer, bare or in a code fence. Throws `holds no JSON` or `is not valid JSON`. */
export function jsonFromAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)?.[1];
  const body = (fenced ?? text).trim();
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start < 0 || end < start) throw new Error('holds no JSON');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new Error('is not valid JSON');
  }
}

/** Reads the criteria out of a framer's answer: a JSON object (`{"criteria": [...]}`) or array, bare or in a code fence. */
export function parseRubricAnswer(text: string): RubricCriterion[] {
  let parsed: unknown;
  try {
    parsed = jsonFromAnswer(text);
  } catch (err) {
    throw new RubricValidationError([`answer: ${(err as Error).message}`]);
  }
  const criteria = Array.isArray(parsed) ? parsed : (parsed as { criteria?: unknown } | null)?.criteria;
  return parseRubricCriteria(criteria);
}
