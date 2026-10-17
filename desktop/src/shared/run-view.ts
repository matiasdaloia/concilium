/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

// What the main process sends the renderer about a code-run directory. Type-only imports from core, so the
// renderer can use this module without bundling core.
import type { DecisionRow, Dissent, SurvivalCell } from '@concilium/core';

export type RankRow = {
  rank: number;
  candidateId: string;
  /** PASS, ISSUES or BLOCKED. */
  report: string;
  disqualified: boolean;
  newFailures: number;
  /** `survived/counted`, or `none counted`. */
  survival: string;
  penalties: number;
  diff: string;
  judgeTotal: number | null;
};

export type RankingView = { rows: RankRow[]; winner: string | null; reason: string };

export type CandidateView = {
  candidateId: string;
  /** `cli[:model]`. */
  runner: string;
  /** The driver's status: `ok`, `error`... */
  status: string;
  branch: string;
  headSha: string | null;
  diff: string | null;
  /** PASS, ISSUES or BLOCKED from the evidence, and why. */
  report: string | null;
  reason: string | null;
};

export type MatrixTest = { id: string; author: string; validity: string; specClause: string; cells: Record<string, SurvivalCell | null> };

/** Each adversarial test on the base and each candidate. `lanes` is `base`, then the candidates. */
export type MatrixView = { lanes: string[]; tests: MatrixTest[]; survival: { candidateId: string; text: string }[] };

export type SynthesisView = {
  skipped: string | null;
  base: string | null;
  branch: string | null;
  headSha: string | null;
  mergeable: boolean;
  mergeBlock: string | null;
  grafts: { id: string; candidateId: string; status: string; reason: string }[];
  dropouts: { candidateId: string; reason: string }[];
};

export type VerdictView = {
  verdict: string;
  reason: string;
  verifier: string;
  /** Set when the verifier is of an author family. */
  sameFamilyReason: string | null;
  headSha: string | null;
  verifiedAt: string;
};

/** A code-run directory as the desktop shows it. A section is null when the run has none or it could not be read. */
export type RunView = {
  dir: string;
  runId: string | null;
  task: string | null;
  status: string | null;
  taskType: string | null;
  baseSha: string | null;
  createdAt: string | null;
  candidates: CandidateView[];
  ranking: RankingView | null;
  matrix: MatrixView | null;
  dissent: Dissent[];
  trail: DecisionRow[];
  synthesis: SynthesisView | null;
  verdict: VerdictView | null;
  /** The markdown reports, as written. */
  reports: { synthesis: string | null; reframe: string | null; verification: string | null };
  /** What was missing, unreadable or newer than this viewer. */
  notes: string[];
};

/** The columns of the ranking table, as in the `## Ranking` table of `synthesis.md`. */
export const RANKING_COLUMNS = ['Rank', 'Candidate', 'Report', 'New gate failures', 'Survival', 'Penalties', 'Diff', 'Judge total'] as const;

/** The cells of one ranking row, in `RANKING_COLUMNS` order. */
export function rankCells(row: RankRow): string[] {
  return [
    String(row.rank),
    row.candidateId,
    `${row.report}${row.disqualified ? ', disqualified' : ''}`,
    String(row.newFailures),
    row.survival,
    String(row.penalties),
    row.diff,
    row.judgeTotal === null ? '-' : String(row.judgeTotal),
  ];
}

/** One ranking row written as its `synthesis.md` table line, so the rendered ranking can be compared with it. */
export function rankingLine(cells: string[]): string {
  return `| ${cells.map((cell, i) => (i === 1 ? `\`${cell}\`` : cell)).join(' | ')} |`;
}
