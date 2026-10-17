/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { IMPLEMENTER_OUTCOMES, type LedgerStats } from '@concilium/core';
import { tableLines } from './roles.js';

function seconds(ms: number | null): string {
  return ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`;
}

/** The win rate table, the other roles' outcomes, and the routing suggestions or why each was withheld. */
export function statsLines(stats: LedgerStats, repoDir: string): string[] {
  const lines = [`Ledger of ${repoDir}: ${stats.runs} code runs`];
  if (stats.byRunner.length === 0) return [...lines, '', 'No code runs recorded for this repo yet.'];
  lines.push(
    '',
    'Implementers by task type and runner (a win is being the base):',
    ...tableLines([
      ['Type', 'Runner', 'Family', 'Runs', 'Wins', 'Win rate', ...IMPLEMENTER_OUTCOMES, 'Mean time'],
      ...stats.byRunner.map((s) => [
        s.taskType, s.runner.spec, s.runner.family ?? '-', String(s.runs), String(s.wins), `${Math.round(s.winRate * 100)}%`,
        ...IMPLEMENTER_OUTCOMES.map((o) => String(s.outcomes[o])), seconds(s.meanWallTimeMs),
      ]),
    ]),
  );
  if (stats.byRole.length > 0) {
    lines.push('', 'Other roles:', ...tableLines([
      ['Role', 'Runner', 'Runs', 'Outcomes'],
      ...stats.byRole.map((s) => [s.role, s.runner.spec, String(s.runs), Object.entries(s.outcomes).map(([o, n]) => `${o} ${n}`).join(', ')]),
    ]));
  }
  lines.push('', `Routing suggestions (at least ${stats.minSample} runs of a task type; a candidate set always spans two model families or more):`);
  for (const s of stats.suggestions) lines.push(`  ${s.taskType}: --agents ${s.candidates.map((r) => r.spec).join(',')} (${s.runs} runs)`);
  for (const w of stats.withheld) lines.push(`  ${w.taskType}: none, ${w.reason}`);
  return lines;
}
