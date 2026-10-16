/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import type { Judgment } from './judging.js';
import { rankCandidates, tieGroups, type EvidenceKey, type RankInput, type WorkerStatus } from './ranking.js';

const CLEAN: EvidenceKey = { disqualified: false, newFailures: 0, survived: 0, counted: 0, penalties: 0 };

function entry(candidateId: string, key: Partial<EvidenceKey> = {}, status: WorkerStatus = 'PASS', size = { lines: 10, files: 1 }): RankInput {
  return { candidateId, status, key: { ...CLEAN, ...key }, size };
}

function judgment(candidates: string[], totals: Record<string, number>, status: Judgment['status'] = 'PASS'): Judgment {
  return { status, candidates, judge: 'gemini', sameFamily: false, sameFamilyReason: null, rubricSha256: 'x', scores: [], totals, reason: status === 'PASS' ? 'scored' : 'rubric changed' };
}

const ids = (r: ReturnType<typeof rankCandidates>) => r.order.map((e) => `${e.rank} ${e.candidateId}`);

describe('rankCandidates', () => {
  it('should order by disqualified last, then new gate failures, survival rate and penalties', () => {
    const ranking = rankCandidates([
      entry('dq', { disqualified: true }, 'ISSUES'),
      entry('penalised', { survived: 2, counted: 2, penalties: 1 }, 'ISSUES'),
      entry('failing', { newFailures: 1, survived: 2, counted: 2 }, 'ISSUES'),
      entry('half', { survived: 1, counted: 2 }, 'ISSUES'),
      entry('best', { survived: 2, counted: 2 }),
      entry('blocked', {}, 'BLOCKED'),
    ], []);
    expect(ids(ranking)).toEqual(['1 best', '2 penalised', '3 half', '4 failing', '5 dq', '6 blocked']);
    expect(ranking).toMatchObject({ winner: 'best', reason: 'best on the evidence', judgments: [] });
    expect(ranking.order[0].judgeTotal).toBeNull();
  });

  it('should compare survival as a rate, and count no counted tests as surviving all', () => {
    expect(ids(rankCandidates([entry('a', { survived: 1, counted: 2 }), entry('b', { survived: 2, counted: 4 }), entry('c')], []))).toEqual(['1 c', '2 a', '2 b']);
  });

  it('should let a judge order only an exact tie, never move a candidate across evidence', () => {
    const entries = [entry('a'), entry('b'), entry('c', { penalties: 1 }, 'ISSUES')];
    // The judge prefers c, which is not in the tie: it has no say on c.
    const ranking = rankCandidates(entries, [judgment(['b', 'a'], { a: 10, b: 20, c: 100 })]);
    expect(ids(ranking)).toEqual(['1 b', '2 a', '3 c']);
    expect(ranking).toMatchObject({ winner: 'b', reason: 'tied on the evidence, ordered by the judge' });
    expect(ranking.order.map((e) => e.judgeTotal)).toEqual([20, 10, null]);

    // Without the judgment only the order inside the tie changes: the smaller diff wins it.
    const unjudged = rankCandidates([entry('a'), entry('b', {}, 'PASS', { lines: 4, files: 2 }), entries[2]], []);
    expect(ids(unjudged)).toEqual(['1 b', '2 a', '3 c']);
    expect(unjudged).toMatchObject({ winner: 'b', reason: 'tie broken by smallest diff: a, b tie on the evidence and no judge ran; b changes 4 lines in 2 files' });
  });

  it('should break a top tie the judge left unresolved by the smallest diff, then fewer files, then candidate id', () => {
    const small = { lines: 3, files: 1 };
    // A BLOCKED judgment, one covering other candidates, and equal scores all leave the tie to the diff size.
    expect(rankCandidates([entry('a'), entry('b', {}, 'PASS', small)], [judgment(['a', 'b'], {}, 'BLOCKED')])).toMatchObject({
      winner: 'b', reason: 'tie broken by smallest diff: a, b tie on the evidence and the judge is BLOCKED: rubric changed; b changes 3 lines in 1 file',
    });
    expect(ids(rankCandidates([entry('a'), entry('b', {}, 'PASS', small)], [judgment(['a', 'b', 'c'], { a: 1, b: 2 })]))).toEqual(['1 b', '2 a']);
    const equal = rankCandidates([entry('a'), entry('b', {}, 'PASS', small)], [judgment(['a', 'b'], { a: 5, b: 5 })]);
    expect(equal).toMatchObject({ winner: 'b', reason: 'tie broken by smallest diff: a, b tie on the evidence and the judge scored them the same; b changes 3 lines in 1 file' });
    expect(equal.order.map((e) => e.judgeTotal)).toEqual([5, 5]);

    // Same lines: fewer files wins. Same lines and files: the first candidate id wins. The rest stay tied behind it.
    expect(ids(rankCandidates([entry('a', {}, 'PASS', { lines: 3, files: 2 }), entry('b', {}, 'PASS', small)], []))).toEqual(['1 b', '2 a']);
    expect(ids(rankCandidates([entry('c'), entry('b'), entry('a')], []))).toEqual(['1 a', '2 b', '2 c']);

    // Only the top tie is broken; a tie lower down stays tied, and a judge-ordered top tie stays as the judge put it.
    expect(ids(rankCandidates([entry('a'), entry('b', { penalties: 1 }), entry('c', { penalties: 1 }, 'PASS', small)], []))).toEqual(['1 a', '2 b', '2 c']);
    expect(rankCandidates([entry('a'), entry('b', {}, 'PASS', small)], [judgment(['a', 'b'], { a: 9, b: 1 })])).toMatchObject({ winner: 'a', reason: 'tied on the evidence, ordered by the judge' });
  });

  it('should name no winner when every candidate is blocked or disqualified', () => {
    const ranking = rankCandidates([entry('a', { disqualified: true }, 'ISSUES'), entry('b', {}, 'BLOCKED')], []);
    expect(ranking).toMatchObject({ winner: null, reason: 'no winner: every candidate is blocked or disqualified' });
    expect(rankCandidates([], [])).toMatchObject({ winner: null, reason: 'no candidates' });
  });
});

describe('tieGroups', () => {
  it('should group exact ties in evidence order, blocked candidates together last', () => {
    const groups = tieGroups([entry('x', {}, 'BLOCKED'), entry('a', { newFailures: 1 }), entry('b'), entry('c'), entry('y', { newFailures: 3 }, 'BLOCKED')]);
    expect(groups.map((g) => g.map((e) => e.candidateId))).toEqual([['b', 'c'], ['a'], ['x', 'y']]);
  });
});
