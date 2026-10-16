/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { Judgment } from './judging.js';

/**
 * A worker's verdict on its own work, from the evidence Concilium gathered, never from what the agent said.
 * `BLOCKED`: there is nothing to judge (no branch head, no change). `ISSUES`: some evidence is against it.
 */
export type WorkerStatus = 'PASS' | 'ISSUES' | 'BLOCKED';

/**
 * One fact a report rests on. `ok: false` is what makes a report `ISSUES`. A `judge` fact is added after the judge
 * ran, to flag a same-family judge; it is about the ordering, not the work, so it is `ok: true`.
 */
export type ReportEvidence = {
  kind: 'agent' | 'gate' | 'integrity' | 'survival' | 'playbook' | 'judge';
  ok: boolean;
  detail: string;
  /** The commit the fact is about, when it ran at one. */
  sha?: string;
};

/** The per-candidate worker report: exact SHAs, the evidence, and a short reason. */
export type CandidateReport = {
  status: WorkerStatus;
  branch: string;
  baseSha: string;
  headSha: string | null;
  evidence: ReportEvidence[];
  reason: string;
};

/** What ranks a candidate, in order: disqualified last, then fewer new gate failures, higher survival, fewer penalties. */
export type EvidenceKey = {
  disqualified: boolean;
  newFailures: number;
  /** Adversarial tests by other families it passed, of those that count. With none counted, the rate is 1. */
  survived: number;
  counted: number;
  penalties: number;
};

export type RankInput = { candidateId: string; status: WorkerStatus; key: EvidenceKey };

export type RankEntry = RankInput & {
  /** 1 is best. Candidates still tied after the judge share a rank. */
  rank: number;
  /** The judge's weighted total, when a judge ordered its tie group. */
  judgeTotal: number | null;
};

export type Ranking = {
  order: RankEntry[];
  /** The candidate ranked first alone, unless it is blocked or disqualified. */
  winner: string | null;
  reason: string;
  judgments: Judgment[];
};

/** Negative when `a` ranks before `b`, 0 on an exact tie. Blocked candidates go last and tie with each other. */
export function compareEvidence(a: RankInput, b: RankInput): number {
  const blocked = Number(a.status === 'BLOCKED') - Number(b.status === 'BLOCKED');
  if (blocked !== 0 || a.status === 'BLOCKED') return blocked;
  const [sa, ca] = a.key.counted ? [a.key.survived, a.key.counted] : [1, 1];
  const [sb, cb] = b.key.counted ? [b.key.survived, b.key.counted] : [1, 1];
  return Number(a.key.disqualified) - Number(b.key.disqualified)
    || a.key.newFailures - b.key.newFailures
    || sb * ca - sa * cb
    || a.key.penalties - b.key.penalties;
}

/** The candidates in evidence order, split into groups of exact ties. */
export function tieGroups(entries: RankInput[]): RankInput[][] {
  const sorted = [...entries].sort(compareEvidence);
  const groups: RankInput[][] = [];
  for (const entry of sorted) {
    const last = groups.at(-1);
    if (last && compareEvidence(last[0], entry) === 0) last.push(entry);
    else groups.push([entry]);
  }
  return groups;
}

/** Can win: not blocked and not disqualified. Only ties of such candidates go to a judge. */
export function contends(entry: RankInput): boolean {
  return entry.status !== 'BLOCKED' && !entry.key.disqualified;
}

/**
 * The final ranking, a pure function of the evidence and the judgments. A `PASS` judgment covering exactly a tie
 * group orders that group by its totals; nothing else can move a candidate, so dropping every judgment changes
 * only the order inside tie groups.
 */
export function rankCandidates(entries: RankInput[], judgments: Judgment[]): Ranking {
  const order: RankEntry[] = [];
  for (const group of tieGroups(entries)) {
    const ids = group.map((e) => e.candidateId).sort();
    const judgment = group.length > 1
      ? judgments.find((j) => j.status === 'PASS' && [...j.candidates].sort().join('\n') === ids.join('\n'))
      : undefined;
    const total = (e: RankInput) => judgment?.totals[e.candidateId] ?? 0;
    const ordered = judgment ? [...group].sort((a, b) => total(b) - total(a)) : group;
    const groupStart = order.length + 1;
    ordered.forEach((entry, i) => {
      const prev = order.at(-1);
      const tiedWithPrev = i > 0 && (!judgment || total(entry) === total(ordered[i - 1]));
      order.push({ ...entry, rank: tiedWithPrev && prev ? prev.rank : groupStart + i, judgeTotal: judgment ? total(entry) : null });
    });
  }

  const top = order[0];
  if (!top) return { order, winner: null, reason: 'no candidates', judgments };
  if (!contends(top)) return { order, winner: null, reason: 'no winner: every candidate is blocked or disqualified', judgments };
  const firsts = order.filter((e) => e.rank === 1);
  if (firsts.length > 1) {
    const judgment = judgments.find((j) => j.candidates.includes(top.candidateId));
    const why = !judgment ? 'no judge ran' : judgment.status === 'PASS' ? 'the judge scored them the same' : `the judge is BLOCKED: ${judgment.reason}`;
    return { order, winner: null, reason: `no winner: ${firsts.map((e) => e.candidateId).join(', ')} tie on the evidence and ${why}`, judgments };
  }
  const judged = top.judgeTotal !== null;
  return { order, winner: top.candidateId, reason: judged ? 'tied on the evidence, ordered by the judge' : 'best on the evidence', judgments };
}
