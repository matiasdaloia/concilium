/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { PLAYBOOKS, type TaskTypeChoice } from './playbooks.js';
import type { FrozenRubric } from './rubric.js';

/** What every candidate of a run shares, fixed before the first one starts. */
export type CodeFrame = { taskType: TaskTypeChoice; rubric: FrozenRubric };

/**
 * The task, then the type's playbook steps and verification verbatim.
 * Candidates never see the rubric: it takes a task type, not a frame, so the rubric cannot reach a brief.
 */
export function framedTask(task: string, taskType: TaskTypeChoice): string {
  const playbook = PLAYBOOKS[taskType.type];
  return [
    task,
    '',
    `## Playbook: ${playbook.type}`,
    'Follow these steps in order. In your final message, list every step as done, or as skipped with the reason.',
    ...playbook.steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    '## Verification expected',
    ...playbook.verification.map((line) => `- ${line}`),
  ].join('\n');
}

/**
 * The playbook steps (1-based) a candidate's final message does not acknowledge. A step is acknowledged by a line
 * that starts with its number (after list markers, `Step`, bold) and says `done`, `skip` or `skipped`.
 */
export function missingPlaybookSteps(finalText: string, stepCount: number): number[] {
  const lines = finalText.split('\n');
  const missing: number[] = [];
  for (let n = 1; n <= stepCount; n++) {
    const numbered = new RegExp(`^[\\s>*_#-]*(?:step\\s*)?${n}(?!\\d)`, 'i');
    if (!lines.some((line) => numbered.test(line) && /\b(done|skip|skipped)\b/i.test(line))) missing.push(n);
  }
  return missing;
}
