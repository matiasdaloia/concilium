/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { isAbsolute, normalize } from 'node:path';
import type { TaskType } from '../code-council/playbooks.js';
import type { Brief } from '../driver/brief.js';
import type { Gate, GatePlan } from './gates.js';
import { isTestFile } from './integrity.js';

/** The file an adversary writes at the root of its worktree to list its tests. */
export const ADVERSARIAL_MANIFEST = 'concilium-adversarial.json';

/** Tests kept per adversary; the rest are dropped with a note, since every test runs once per lane. */
export const MAX_TESTS_PER_ADVERSARY = 5;

/** One adversarial test run in one lane. `error`: it could not be judged there (timeout, or the suite already fails without it). */
export type SurvivalCell = 'pass' | 'fail' | 'error';

/** `matrix[testId][lane]`, where a lane is `base` or a candidate id. */
export type SurvivalMatrix = Record<string, Record<string, SurvivalCell>>;

/**
 * The validity rule (B6 Tier 2), from the test's result on the base and on the candidates:
 * - `evidence`: fails on the base and passes on at least one candidate of another family than its author.
 * - `own-family-only`: fails on the base and passes only on candidates of its author's family; carries no weight.
 * - `quarantined`: fails on the base and on every candidate; kept for the judges, carries no weight.
 * - `vacuous`: passes on the base of a bug fix; dropped.
 * - `regression-guard`: passes on the base of any other task type; kept.
 * - `unrunnable`: could not be judged on the base; carries no weight.
 */
export type TestValidity = 'evidence' | 'own-family-only' | 'quarantined' | 'vacuous' | 'regression-guard' | 'unrunnable';

/** What an adversary says it wrote: the files of one test, and the line of the task it enforces. */
export type AdversarialTestSpec = { files: string[]; specClause: string };

export type AdversarialTest = AdversarialTestSpec & {
  /** `<family>-<n>`. */
  id: string;
  /** The model family of the adversary that wrote it. Its tests carry no weight for candidates of that family. */
  author: string;
  validity: TestValidity;
};

/** How one candidate fared against the tests that count for it: valid ones (`evidence`, `regression-guard`) by other families. */
export type Survival = { counted: number; survived: number; failed: string[] };

/** The repo's test gate, which runs the adversarial tests: `test`, `npm:test`, `make:test`, `go:test`, `cargo:test` or `pytest`. */
export function testGate(plan: GatePlan): Gate | undefined {
  return plan.gates.find((gate) => /(^|:)test$/.test(gate.name) || gate.name === 'pytest');
}

/**
 * Reads the adversary's manifest: `{"tests": [{"files": ["a.test.js"], "specClause": "..."}]}`. Entries whose files
 * are not relative test paths that exist, or that name no clause, are dropped with a note; at most `max` are kept.
 */
export function parseAdversarialManifest(text: string, exists: (path: string) => boolean, max = MAX_TESTS_PER_ADVERSARY): { tests: AdversarialTestSpec[]; notes: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { tests: [], notes: [`${ADVERSARIAL_MANIFEST} is not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const entries = (doc as { tests?: unknown } | null)?.tests;
  if (!Array.isArray(entries)) return { tests: [], notes: [`${ADVERSARIAL_MANIFEST} has no "tests" list`] };

  const tests: AdversarialTestSpec[] = [];
  const notes: string[] = [];
  entries.forEach((entry: unknown, i) => {
    const { files, specClause } = (typeof entry === 'object' && entry !== null ? entry : {}) as { files?: unknown; specClause?: unknown };
    const problem = typeof specClause !== 'string' || !specClause.trim() ? 'names no specClause'
      : !Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === 'string') ? 'lists no files'
      : (files as string[]).map((f) => fileProblem(f, exists)).find(Boolean);
    if (problem) notes.push(`tests[${i}] dropped: ${problem}`);
    else tests.push({ files: (files as string[]).map((f) => normalize(f)), specClause: (specClause as string).trim() });
  });
  if (tests.length > max) {
    notes.push(`${tests.length - max} tests over the limit of ${max} dropped`);
    tests.length = max;
  }
  return { tests, notes };
}

function fileProblem(path: string, exists: (path: string) => boolean): string | undefined {
  const rel = normalize(path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return `${path} is outside the worktree`;
  if (!isTestFile(rel)) return `${path} is not a test file`;
  if (!exists(rel)) return `${path} does not exist`;
  return undefined;
}

/** The validity rule (see `TestValidity`), for a test by `author` with its cell on each candidate. */
export function classifyTest(base: SurvivalCell, candidates: { family: string; cell: SurvivalCell }[], author: string, type: TaskType): TestValidity {
  if (base === 'error') return 'unrunnable';
  if (base === 'pass') return type === 'bugfix' ? 'vacuous' : 'regression-guard';
  const passed = candidates.filter((c) => c.cell === 'pass');
  if (passed.some((c) => c.family !== author)) return 'evidence';
  return passed.length > 0 ? 'own-family-only' : 'quarantined';
}

/** Each candidate's survival over the valid tests other families wrote. */
export function survival(tests: AdversarialTest[], matrix: SurvivalMatrix, candidates: { candidateId: string; family: string }[]): Record<string, Survival> {
  const result: Record<string, Survival> = {};
  for (const { candidateId, family } of candidates) {
    const counted = tests.filter((t) => (t.validity === 'evidence' || t.validity === 'regression-guard') && t.author !== family);
    const failed = counted.filter((t) => matrix[t.id]?.[candidateId] !== 'pass').map((t) => t.id);
    result[candidateId] = { counted: counted.length, survived: counted.length - failed.length, failed };
  }
  return result;
}

/**
 * The write-mode brief of an adversary: write tests for the task that fail on the base, aimed at the weak spots of
 * the peers' diffs (read-only patch files outside its worktree), each naming the line of the task it enforces.
 */
export function adversaryBrief(input: { task: string; type: TaskType; worktree: string; testCommand: string; patches: string[] }): Brief {
  return {
    version: 1,
    task: [
      `You are an adversary reviewing ${input.patches.length || 'no'} candidate solutions to a ${input.type} task. The task:`,
      '',
      input.task,
      '',
      'Write tests that a correct solution passes and that fail on the code in your directory, which is the project before any candidate changed it.',
      'Aim them at what the task asks for and at the weak spots in the candidates\' diffs: edge cases they miss, inputs they mishandle.',
      'Every test enforces one requirement of the task: quote the sentence or phrase of the task it checks as its specClause.',
      `Do not change the project's code. Add new test files only, in the project's test style, where \`${input.testCommand}\` runs them.`,
      `When you are done, write ${ADVERSARIAL_MANIFEST} at the root of your directory, listing at most ${MAX_TESTS_PER_ADVERSARY} tests:`,
      '{"tests": [{"files": ["path/to/new.test.js"], "specClause": "the part of the task this test enforces"}]}',
    ].join('\n'),
    mode: 'code',
    cwd: input.worktree,
    constraints: [
      `You are in ${input.worktree}, a scratch git worktree. Make every change inside this directory; do not commit, push or switch branches.`,
      ...input.patches.map((patch) => `Candidate diff, read-only: ${patch}`),
    ],
    allowedActions: ['read', 'write', 'shell'],
  };
}
