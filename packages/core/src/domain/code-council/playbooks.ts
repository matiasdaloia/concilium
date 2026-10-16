/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { RubricCriterion } from './rubric.js';

export const TASK_TYPES = ['bugfix', 'feature', 'refactor', 'perf', 'prototype'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export function isTaskType(value: string): value is TaskType {
  return (TASK_TYPES as readonly string[]).includes(value);
}

/** The fixed way to do one type of task. Steps go into every candidate brief verbatim and in order. */
export type Playbook = {
  type: TaskType;
  steps: string[];
  /** What a candidate must show to count as verified. */
  verification: string[];
  /** The rubric when the framer cannot tailor one. 3 to 6 criteria. */
  rubric: RubricCriterion[];
};

const NO_REGRESSIONS: RubricCriterion = {
  name: 'no-regressions',
  description: 'The existing tests, typecheck and lint still pass on the branch.',
  weight: 2,
  evidence: 'gate',
};

export const PLAYBOOKS: Record<TaskType, Playbook> = {
  bugfix: {
    type: 'bugfix',
    steps: [
      'Reproduce the bug first: write a test that fails because of it, run it, and watch it fail before you change any code.',
      'Find the cause with runtime evidence (output, logs, narrowing the inputs), not by guessing.',
      'Make the smallest change the evidence justifies.',
      'Commit the failing test on its own before the fix, so it lands first in history.',
      'Run the repro test and the existing tests again: the repro now passes and nothing else broke.',
    ],
    verification: [
      'A test that fails on the base and passes with the fix.',
      'The existing tests still pass.',
    ],
    rubric: [
      { name: 'reproduced', description: 'A test reproduces the bug: it fails on the base and passes on the branch.', weight: 3, evidence: 'gate' },
      NO_REGRESSIONS,
      { name: 'root-cause', description: 'The change fixes the cause, not a symptom, and holds against tests written by other candidates.', weight: 2, evidence: 'adversarial' },
      { name: 'minimal', description: 'The diff is the smallest change the evidence justifies.', weight: 1, evidence: 'judgment' },
    ],
  },
  feature: {
    type: 'feature',
    steps: [
      'Name the data shape first: the types and the data the feature reads and writes.',
      'Find the blocking steps, the independent pieces and the shared state, and pick the smallest decomposition.',
      'Build it in small, ordered commits, each with its tests.',
      'Verify it through the surface a user touches (the command, endpoint or screen), not only through unit tests.',
    ],
    verification: [
      'Tests for the new behavior.',
      'The existing tests still pass.',
      'The feature exercised through its real entry point.',
    ],
    rubric: [
      { name: 'works', description: 'The feature does what the task asks, shown by tests through its real entry point.', weight: 3, evidence: 'gate' },
      NO_REGRESSIONS,
      { name: 'edge-cases', description: 'It holds against edge-case tests written by other candidates.', weight: 2, evidence: 'adversarial' },
      { name: 'fit', description: "It follows the codebase's existing patterns and keeps its boundaries clear.", weight: 1, evidence: 'judgment' },
    ],
  },
  refactor: {
    type: 'refactor',
    steps: [
      'Pin the current behavior with a characterization test before you move any structure.',
      'Subtract before adding: delete dead code and duplication first.',
      'Move in small behavior-preserving steps, and keep the pinned tests green after each one.',
      'Show equivalence: the same tests pass before and after, and no test was changed to fit.',
      'If the code is not easier to read at the end, revert instead.',
    ],
    verification: [
      'Characterization tests that pass on the base and on the branch.',
      'No test changed to fit the new code.',
    ],
    rubric: [
      { name: 'behavior-preserved', description: 'Characterization tests pass on the base and on the branch.', weight: 3, evidence: 'gate' },
      { name: 'equivalence', description: 'No behavior change shows up under tests written by other candidates.', weight: 2, evidence: 'adversarial' },
      { name: 'reader-load', description: 'The code is easier to read: less code and fewer concepts.', weight: 2, evidence: 'judgment' },
    ],
  },
  perf: {
    type: 'perf',
    steps: [
      'Measure a baseline first, with a probe you can rerun (a benchmark, a timing, a profile).',
      'Form hypotheses from the trace or profile, not from intuition.',
      'Change one thing at a time, and measure again with the same probe.',
      'Report the numbers before and after.',
    ],
    verification: [
      'The same probe run on the base and on the branch, with both numbers.',
      'The existing tests still pass.',
    ],
    rubric: [
      { name: 'measured-gain', description: 'The same probe shows an improvement from the base to the branch, with numbers.', weight: 3, evidence: 'gate' },
      NO_REGRESSIONS,
      { name: 'same-results', description: 'Results stay the same under tests written by other candidates.', weight: 2, evidence: 'adversarial' },
      { name: 'contained', description: 'The optimization is contained and explained where it lives.', weight: 1, evidence: 'judgment' },
    ],
  },
  prototype: {
    type: 'prototype',
    steps: [
      'Name the decision the prototype must inform.',
      'Write throwaway code in a scratch directory; it will not be merged.',
      'Build the variants side by side so they can be compared.',
      'Finish with a decision and the evidence for it, not mergeable code.',
    ],
    verification: ['A written decision (DECISION.md) with the evidence from the variants that ran.'],
    rubric: [
      { name: 'decision', description: 'The output names the decision and recommends one option.', weight: 3, evidence: 'judgment' },
      { name: 'evidence', description: 'The recommendation rests on evidence from variants that actually ran.', weight: 2, evidence: 'judgment' },
      { name: 'comparable', description: 'The variants can be compared side by side.', weight: 1, evidence: 'judgment' },
    ],
  },
};

/** How a run got its type: `--type`, or the keyword classifier, with the reason either way. */
export type TaskTypeChoice = { type: TaskType; source: 'flag' | 'classifier'; reason: string };

// Checked in order: the first type with a matching keyword wins, so "fix the slow query" is perf.
const KEYWORDS: [TaskType, RegExp][] = [
  ['prototype', /\b(prototype|spike|proof of concept|poc|experiment|try out)\b/i],
  ['perf', /\b(perf|performance|faster|slow|slowness|speed up|latency|throughput|optimi[sz]e|benchmark)\b/i],
  ['bugfix', /\b(fix|fixes|bug|bugs|broken|crash|crashes|regression|flaky|fails|failing|incorrect)\b/i],
  ['refactor', /\b(refactor|clean up|cleanup|restructure|rename|extract|simplify|reorganize|deduplicate)\b/i],
];

// TODO(M3): raise the rigor when the task touches risky paths (auth, migrations, payments).
/** Picks a type from keywords in the task. With no keyword, `feature`. */
export function classifyTask(task: string): TaskTypeChoice {
  for (const [type, pattern] of KEYWORDS) {
    const match = pattern.exec(task);
    if (match) return { type, source: 'classifier', reason: `the task mentions "${match[0].toLowerCase()}"` };
  }
  return { type: 'feature', source: 'classifier', reason: 'no keyword matched, feature is the default' };
}
