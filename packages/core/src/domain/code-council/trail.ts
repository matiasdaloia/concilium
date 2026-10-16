/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

/** The decision trail, in the run directory: one row per orchestrator decision, append-only. */
export const DECISIONS_FILE = 'decisions.tsv';

/** The orchestrator's event log, one JSON object per line; every decision row points at its `decision` event. */
export const EVENTS_FILE = 'events.jsonl';

/** The frozen rubric, the evidence of the `rubric` row. */
export const RUBRIC_FILE = 'rubric.json';

export const DECISION_COLUMNS = ['ts', 'event', 'step', 'decision', 'chosen', 'alternatives', 'evidence', 'reason'] as const;

/**
 * What the orchestrator decided, the options it had, and why. `evidence` holds pointers that must resolve:
 * `commit:<sha>` in the target repo, or `file:<path>` relative to the run directory.
 */
export type Decision = {
  step: string;
  decision: string;
  chosen: string;
  alternatives: string[];
  evidence: string[];
  reason: string;
};

/** A row of `decisions.tsv`: a decision, when it was made, and the `seq` of its event in `events.jsonl`. */
export type DecisionRow = Decision & { ts: string; event: number };

export type TrailEvent = { seq: number; ts: string; type: string } & Record<string, unknown>;

/** `line` is the line of `decisions.tsv`, or 0 for a problem of `events.jsonl` as a whole. */
export type TrailProblem = { line: number; message: string };

export function commitPointer(sha: string): string {
  return `commit:${sha}`;
}

export function filePointer(path: string): string {
  return `file:${path}`;
}

const LIST_SEPARATOR = ' | ';

function cell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n') || '-';
}

const UNESCAPE: Record<string, string> = { '\\': '\\', t: '\t', n: '\n', r: '\r' };

function uncell(value: string): string {
  return value === '-' ? '' : value.replace(/\\([\\tnr])/g, (_, c: string) => UNESCAPE[c]);
}

export function decisionsHeader(): string {
  return `${DECISION_COLUMNS.join('\t')}\n`;
}

/** One TSV line; tabs and newlines inside a field are escaped, an empty field is `-`, lists are joined with ` | `. */
export function formatDecisionRow(row: DecisionRow): string {
  const fields = [row.ts, String(row.event), row.step, row.decision, row.chosen, row.alternatives.join(LIST_SEPARATOR), row.evidence.join(LIST_SEPARATOR), row.reason];
  return `${fields.map(cell).join('\t')}\n`;
}

/** The rows of `decisions.tsv` with their line numbers, and the lines that are not rows. */
export function parseDecisions(tsv: string): { rows: (DecisionRow & { line: number })[]; problems: TrailProblem[] } {
  const lines = tsv.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const problems: TrailProblem[] = [];
  if (lines[0] !== DECISION_COLUMNS.join('\t')) problems.push({ line: 1, message: `the header is not ${DECISION_COLUMNS.join(', ')}` });
  const rows = lines.slice(1).flatMap((text, i) => {
    const line = i + 2;
    const fields = text.split('\t');
    if (fields.length !== DECISION_COLUMNS.length) {
      problems.push({ line, message: `${fields.length} columns, expected ${DECISION_COLUMNS.length}` });
      return [];
    }
    const [ts, event, step, decision, chosen, alternatives, evidence, reason] = fields.map(uncell);
    if (!/^\d+$/.test(event)) {
      problems.push({ line, message: `event "${event}" is not an event number` });
      return [];
    }
    const list = (value: string) => (value === '' ? [] : value.split(LIST_SEPARATOR));
    return [{ line, ts, event: Number(event), step, decision, chosen, alternatives: list(alternatives), evidence: list(evidence), reason }];
  });
  return { rows, problems };
}

/** The events of `events.jsonl`; a line that is not a JSON event is a problem. */
export function parseEvents(jsonl: string): { events: TrailEvent[]; problems: TrailProblem[] } {
  const problems: TrailProblem[] = [];
  const events = jsonl.split('\n').flatMap((text, i) => {
    if (!text.trim()) return [];
    try {
      const value = JSON.parse(text) as TrailEvent;
      if (typeof value?.seq === 'number' && typeof value.type === 'string') return [value];
    } catch {
      // Reported below.
    }
    problems.push({ line: 0, message: `${EVENTS_FILE} line ${i + 1} is not an event` });
    return [];
  });
  return { events, problems };
}

/** The pointers of every row, to resolve before `auditTrail`. */
export function trailPointers(rows: Decision[]): string[] {
  return [...new Set(rows.flatMap((r) => r.evidence))];
}

function sameList(a: string[], b: unknown): boolean {
  return Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The consistency check of M6.2. Every row must be the `decision` event it names, field for field, in event order,
 * with at least one evidence pointer, each of which `resolves`; every `decision` event must have exactly one row.
 * A row written by hand has no event, or does not match the one it names.
 */
export function auditTrail(tsv: string, jsonl: string, resolves: (pointer: string) => boolean): TrailProblem[] {
  const parsed = parseDecisions(tsv);
  const log = parseEvents(jsonl);
  const problems = [...parsed.problems, ...log.problems];
  const events = new Map(log.events.map((e) => [e.seq, e]));
  const seen = new Set<number>();
  let last = 0;
  for (const row of parsed.rows) {
    const at = (message: string) => problems.push({ line: row.line, message: `${row.step || 'row'}: ${message}` });
    const event = events.get(row.event);
    if (!event) at(`no event ${row.event} in ${EVENTS_FILE}`);
    else if (event.type !== 'decision') at(`event ${row.event} is a ${event.type} event, not a decision`);
    else {
      const differs: string[] = (['ts', 'step', 'decision', 'chosen', 'reason'] as const).filter((k) => event[k] !== row[k]);
      if (!sameList(row.alternatives, event.alternatives)) differs.push('alternatives');
      if (!sameList(row.evidence, event.evidence)) differs.push('evidence');
      if (differs.length > 0) at(`does not match event ${row.event} (${differs.join(', ')})`);
    }
    if (seen.has(row.event)) at(`a second row for event ${row.event}`);
    else if (row.event < last) at(`event ${row.event} comes after event ${last}: the trail is append-only`);
    seen.add(row.event);
    last = Math.max(last, row.event);
    if (row.evidence.length === 0) at('no evidence');
    for (const pointer of row.evidence) if (!resolves(pointer)) at(`evidence ${pointer} does not resolve`);
  }
  for (const event of log.events) {
    if (event.type === 'decision' && !seen.has(event.seq)) problems.push({ line: 0, message: `decision event ${event.seq} (${String(event.step)}) has no row` });
  }
  return problems;
}
