/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { PLAYBOOKS, type TaskTypeChoice } from './playbooks.js';
import type { FrozenRubric } from './rubric.js';

/** What every candidate of a run shares, fixed before the first one starts. */
export type CodeFrame = { taskType: TaskTypeChoice; rubric: FrozenRubric };

/** The task, then the type's playbook steps and verification verbatim, then the frozen rubric. */
export function framedTask(task: string, frame: CodeFrame): string {
  const playbook = PLAYBOOKS[frame.taskType.type];
  return [
    task,
    '',
    `## Playbook: ${playbook.type}`,
    'Follow these steps in order. In your final message, list every step as done, or as skipped with the reason.',
    ...playbook.steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    '## Verification expected',
    ...playbook.verification.map((line) => `- ${line}`),
    '',
    '## Rubric',
    `Your work will be judged on these criteria, fixed before you started (sha256 ${frame.rubric.sha256}):`,
    ...frame.rubric.criteria.map((c) => `- ${c.name} (weight ${c.weight}, evidence: ${c.evidence}): ${c.description}`),
  ].join('\n');
}
