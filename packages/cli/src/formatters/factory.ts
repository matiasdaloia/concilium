/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { prBranch, type FactoryRecord, type FactoryStep } from '@concilium/core';
import { tableLines } from './roles.js';

function stepCells(step: FactoryStep | undefined): string[] {
  if (!step) return ['pending', '-', '-', '-', '-'];
  if (step.outcome === 'not-run') return ['not run', '-', '-', '-', '-'];
  const verdict = step.outcome === 'shipped' ? `${step.verdict}${step.sameFamily ? ' (same family)' : ''}` : step.verdict ?? '-';
  return [step.outcome, step.runId, step.baseSha.slice(0, 12), step.outcome === 'shipped' ? step.headSha.slice(0, 12) : '-', verdict];
}

/**
 * The factory's tasks with each one's run, base, verified head and verdict, why the chain stopped, and the
 * `concilium pr` commands that would ship the stack in order, each PR based on the one before it. Nothing here pushes.
 */
export function factoryLines(record: FactoryRecord, dir: string): string[] {
  const lines = [
    `Factory ${record.id} in ${record.repoDir}: ${record.status}`,
    `Spec ${record.specPath} (sha256 ${record.specSha256.slice(0, 12)}), planned by ${record.planner}, from ${record.baseSha.slice(0, 12)}`,
    '',
    ...tableLines([
      ['Task', 'Type', 'Outcome', 'Run', 'Base', 'Head', 'Verdict'],
      ...record.tasks.map((t) => [t.id, t.type, ...stepCells(record.steps.find((s) => s.taskId === t.id))]),
    ]),
  ];
  for (const step of record.steps) {
    if (step.outcome === 'stopped') lines.push('', `Stopped at ${step.taskId}: ${step.reason}`, `  Inspect: concilium status ${step.runId}`);
    if (step.outcome === 'shipped' && step.sameFamily) lines.push(`Warning: ${step.taskId} was verified by a CLI of an author family`);
  }
  const shipped = record.steps.filter((s): s is Extract<FactoryStep, { outcome: 'shipped' }> => s.outcome === 'shipped');
  if (shipped.length > 0) {
    lines.push('', 'Nothing was pushed. To ship the stack, in order (each pauses its push and PR until you approve):');
    shipped.forEach((s, i) => lines.push(`  concilium pr ${s.runId}${i > 0 ? ` --base ${prBranch(shipped[i - 1].runId)}` : ''}`));
  }
  lines.push('', `Tasks: ${dir}/tasks.md`);
  return lines;
}
