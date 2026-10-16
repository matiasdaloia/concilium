/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { auditTrail, decisionsHeader, formatDecisionRow, parseDecisions, type Decision, type DecisionRow } from './trail.js';

const DECISION: Decision = {
  step: 'ranking', decision: 'rank on the evidence', chosen: 'claude', alternatives: ['codex', 'gemini'],
  evidence: ['commit:abc1234', 'file:result.patch'], reason: 'best on the evidence',
};

function row(event: number, d: Decision = DECISION): DecisionRow {
  return { ts: `2026-10-16T12:00:0${event}.000Z`, event, ...d };
}

/** A trail as the orchestrator writes it: a run-start event, then one decision event and one row per decision. */
function trail(decisions: Decision[]): { tsv: string; jsonl: string } {
  const rows = decisions.map((d, i) => row(i + 2, d));
  return {
    tsv: decisionsHeader() + rows.map(formatDecisionRow).join(''),
    jsonl: [{ seq: 1, ts: 'x', type: 'run-start' }, ...rows.map(({ event, ...r }) => ({ seq: event, type: 'decision', ...r }))].map((e) => `${JSON.stringify(e)}\n`).join(''),
  };
}

const all = () => true;

describe('decisions.tsv format', () => {
  it('should round-trip a row with tabs, newlines, backslashes and empty fields', () => {
    const tricky = row(3, { ...DECISION, reason: 'a\tb\nc\\n', alternatives: [], chosen: '' });
    const line = formatDecisionRow(tricky);

    expect(line.split('\t')).toHaveLength(8);
    expect(line.endsWith('\n')).toBe(true);
    expect(line).toContain('\t-\t');
    expect(parseDecisions(decisionsHeader() + line)).toEqual({ rows: [{ ...tricky, line: 2 }], problems: [] });
  });

  it('should name a bad header, a short row and an event that is not a number', () => {
    const { problems } = parseDecisions('ts\tstep\nonly\ttwo\n' + formatDecisionRow(row(2)).replace('\t2\t', '\tx\t'));
    expect(problems).toEqual([
      { line: 1, message: 'the header is not ts, event, step, decision, chosen, alternatives, evidence, reason' },
      { line: 2, message: '2 columns, expected 8' },
      { line: 3, message: 'event "x" is not an event number' },
    ]);
  });
});

describe('auditTrail', () => {
  it('should pass a trail written by the orchestrator', () => {
    const { tsv, jsonl } = trail([DECISION, { ...DECISION, step: 'mergeable', chosen: 'mergeable' }]);
    expect(auditTrail(tsv, jsonl, all)).toEqual([]);
  });

  it('should flag a row inserted by hand: no event, a progress event, or an event it does not match', () => {
    const { tsv, jsonl } = trail([DECISION]);
    const log = `${jsonl}${JSON.stringify({ seq: 3, ts: 'y', type: 'gate-done' })}\n`;
    const forged = tsv + formatDecisionRow(row(9)) + formatDecisionRow(row(3)) + formatDecisionRow({ ...row(2), chosen: 'codex', evidence: ['commit:abc1234'] });

    expect(auditTrail(forged, log, all)).toEqual([
      { line: 3, message: 'ranking: no event 9 in events.jsonl' },
      { line: 4, message: 'ranking: event 3 is a gate-done event, not a decision' },
      { line: 4, message: 'ranking: event 3 comes after event 9: the trail is append-only' },
      { line: 5, message: 'ranking: does not match event 2 (chosen, evidence)' },
      { line: 5, message: 'ranking: a second row for event 2' },
    ]);
  });

  it('should flag evidence that does not resolve, a row with none, and a decision event with no row', () => {
    const { tsv, jsonl } = trail([DECISION, { ...DECISION, step: 'dissent', evidence: [] }]);
    const dropped = tsv.split('\n').slice(0, 2).join('\n') + '\n';

    expect(auditTrail(tsv, jsonl, (p) => p !== 'file:result.patch')).toEqual([
      { line: 2, message: 'ranking: evidence file:result.patch does not resolve' },
      { line: 3, message: 'dissent: no evidence' },
    ]);
    expect(auditTrail(dropped, jsonl, all)).toEqual([{ line: 0, message: 'decision event 3 (dissent) has no row' }]);
  });

  it('should name an events.jsonl line that is not an event', () => {
    const { tsv, jsonl } = trail([DECISION]);
    expect(auditTrail(tsv, `${jsonl}not json\n{"seq": "1"}\n`, all)).toEqual([
      { line: 0, message: 'events.jsonl line 3 is not an event' },
      { line: 0, message: 'events.jsonl line 4 is not an event' },
    ]);
  });
});
