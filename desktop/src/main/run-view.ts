/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import {
  DECISIONS_FILE,
  DISSENT_FILE,
  REFRAME_REPORT,
  SYNTHESIS_REPORT,
  VERIFICATION_REPORT,
  parseDecisions,
  type CodeRunRecord,
  type DecisionRow,
  type Dissent,
  type SurvivalCell,
} from '@concilium/core';
import type { CandidateView, MatrixTest, MatrixView, RankingView, RankRow, RunView, SynthesisView, VerdictView } from '../shared/run-view';

/** The run record a CLI code run writes (`JsonCodeRunStore`). */
export const RUN_RECORD = 'run.json';

/** The only files the viewer reads from a run directory, by name. */
export const RUN_FILES = [RUN_RECORD, SYNTHESIS_REPORT, DISSENT_FILE, DECISIONS_FILE, VERIFICATION_REPORT, REFRAME_REPORT] as const;
export type RunFileName = (typeof RUN_FILES)[number];

/** The text of each run file that exists. */
export type RunFiles = Partial<Record<RunFileName, string>>;

/** The run record version this viewer was written for; a newer one is shown as far as it reads. */
export const KNOWN_RECORD_VERSION = 1;

/** A record read from disk: any field may be missing or null. */
type Loose<T> = { [K in keyof T]?: T[K] extends object ? Loose<T[K]> | null : T[K] | null };

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function list<T>(value: unknown): Loose<T>[] {
  return Array.isArray(value) ? value.filter((v): v is Loose<T> => typeof v === 'object' && v !== null) : [];
}

/** Runs one section's reader; a shape it does not expect makes the section null with a note, never the whole view. */
function section<T>(name: string, notes: string[], read: () => T | null): T | null {
  try {
    return read();
  } catch (err) {
    notes.push(`could not read the ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function parseJson(name: string, raw: string | undefined, notes: string[]): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    notes.push(`${name} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function readRecord(raw: string | undefined, notes: string[]): Loose<CodeRunRecord> | null {
  if (raw === undefined) {
    notes.push(`no ${RUN_RECORD}: showing only the reports`);
    return null;
  }
  const value = parseJson(RUN_RECORD, raw, notes);
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Loose<CodeRunRecord> & { kind?: unknown; version?: unknown };
  if (record.kind !== 'code') {
    notes.push(`${RUN_RECORD} is not a code run (kind ${JSON.stringify(record.kind ?? null)})`);
    return null;
  }
  if (record.version !== KNOWN_RECORD_VERSION) {
    notes.push(`${RUN_RECORD} is version ${JSON.stringify(record.version ?? null)}; this viewer knows version ${KNOWN_RECORD_VERSION} and shows what it can read`);
  }
  return record;
}

function rankingView(record: Loose<CodeRunRecord>): RankingView | null {
  const ranking = record.ranking;
  if (!ranking) return null;
  const rows = list<CodeRunRecord['ranking']['order'][number]>(ranking.order).map((e): RankRow => {
    const key = e.key ?? {};
    return {
      rank: count(e.rank),
      candidateId: text(e.candidateId) ?? '?',
      report: text(e.status) ?? '?',
      disqualified: key.disqualified === true,
      newFailures: count(key.newFailures),
      survival: count(key.counted) ? `${count(key.survived)}/${count(key.counted)}` : 'none counted',
      penalties: count(key.penalties),
      diff: `${count(e.size?.lines)} lines, ${count(e.size?.files)} files`,
      judgeTotal: typeof e.judgeTotal === 'number' ? e.judgeTotal : null,
    };
  });
  return { rows, winner: text(ranking.winner), reason: text(ranking.reason) ?? '' };
}

function candidateViews(record: Loose<CodeRunRecord>): CandidateView[] {
  return list<CodeRunRecord['candidates'][number]>(record.candidates).map((c) => {
    const diff = c.diffStat;
    return {
      candidateId: text(c.candidateId) ?? '?',
      runner: [text(c.provider), text(c.model)].filter(Boolean).join(':'),
      status: text(c.status) ?? '?',
      branch: text(c.branch) ?? '',
      headSha: text(c.headSha),
      diff: diff ? `${count(diff.filesChanged)} files, +${count(diff.insertions)} -${count(diff.deletions)}` : null,
      report: text(c.report?.status),
      reason: text(c.report?.reason),
    };
  });
}

function matrixView(record: Loose<CodeRunRecord>): MatrixView | null {
  const round = record.adversarial;
  if (!round || round.skipped) return null;
  const candidates = list<CodeRunRecord['candidates'][number]>(record.candidates).map((c) => text(c.candidateId) ?? '?');
  const lanes = ['base', ...candidates];
  const matrix = (round.matrix ?? {}) as Record<string, Record<string, unknown> | null>;
  const tests = list<NonNullable<CodeRunRecord['adversarial']>['tests'][number]>(round.tests).map((t): MatrixTest => {
    const id = text(t.id) ?? '?';
    const row = matrix[id] ?? {};
    const cells: Record<string, SurvivalCell | null> = {};
    for (const lane of lanes) {
      const cell = row[lane];
      cells[lane] = cell === 'pass' || cell === 'fail' || cell === 'error' ? cell : null;
    }
    return { id, author: text(t.author) ?? '?', validity: text(t.validity) ?? '?', specClause: text(t.specClause) ?? '', cells };
  });
  const survival = Object.entries((round.survival ?? {}) as Record<string, { counted?: unknown; survived?: unknown } | null>).map(([candidateId, s]) => ({
    candidateId,
    text: count(s?.counted) ? `${count(s?.survived)}/${count(s?.counted)}` : 'none counted',
  }));
  return { lanes, tests, survival };
}

function synthesisView(record: Loose<CodeRunRecord>): SynthesisView | null {
  const s = record.synthesis;
  if (!s) return null;
  return {
    skipped: text(s.skipped),
    base: text(s.base?.candidateId),
    branch: text(s.branch),
    headSha: text(s.headSha),
    mergeable: s.mergeable === true,
    mergeBlock: text(s.mergeBlock),
    grafts: list<NonNullable<CodeRunRecord['synthesis']>['grafts'][number]>(s.grafts).map((g) => ({
      id: text(g.id) ?? '?', candidateId: text(g.candidateId) ?? '?', status: text(g.status) ?? '?', reason: text(g.reason) ?? '',
    })),
    dropouts: list<NonNullable<CodeRunRecord['synthesis']>['dropouts'][number]>(s.dropouts).map((d) => ({
      candidateId: text(d.candidateId) ?? '?', reason: text(d.reason) ?? '',
    })),
  };
}

function verdictView(record: Loose<CodeRunRecord>): VerdictView | null {
  const v = record.prVerdict;
  if (!v) return null;
  const verifier = v.verifier;
  return {
    verdict: text(v.verdict) ?? '?',
    reason: text(v.reason) ?? '',
    verifier: [text(verifier?.provider), text(verifier?.model)].filter(Boolean).join(':') || 'none',
    sameFamilyReason: verifier?.sameFamily ? text(verifier.sameFamilyReason) : null,
    headSha: text(v.headSha),
    verifiedAt: text(v.verifiedAt) ?? '',
  };
}

function isDissent(value: unknown): value is Dissent {
  const d = value as Partial<Dissent> | null;
  return typeof d?.id === 'string' && typeof d.source === 'string' && typeof d.summary === 'string' && typeof d.resolution === 'string';
}

/** `dissent.json` when it is there, else the records on `run.json`. */
function dissentRecords(raw: string | undefined, record: Loose<CodeRunRecord> | null, notes: string[]): Dissent[] {
  const file = parseJson(DISSENT_FILE, raw, notes) as { version?: unknown; records?: unknown } | undefined;
  if (file && file.version !== 1) notes.push(`${DISSENT_FILE} is version ${JSON.stringify(file.version ?? null)}; this viewer knows version 1`);
  const records = file?.records ?? record?.dissent?.records;
  return Array.isArray(records) ? records.filter(isDissent) : [];
}

function trailRows(raw: string | undefined, notes: string[]): DecisionRow[] {
  if (raw === undefined) return [];
  const { rows, problems } = parseDecisions(raw);
  for (const p of problems) notes.push(`${DECISIONS_FILE}:${p.line}: ${p.message}`);
  return rows.map(({ ts, event, step, decision, chosen, alternatives, evidence, reason }) => ({ ts, event, step, decision, chosen, alternatives, evidence, reason }));
}

/** The view of a code-run directory from the text of its files. Pure: anything missing or malformed becomes a note. */
export function parseRunDir(dir: string, files: RunFiles): RunView {
  const notes: string[] = [];
  const record = readRecord(files[RUN_RECORD], notes);
  const fromRecord = <T>(name: string, read: (r: Loose<CodeRunRecord>) => T | null): T | null =>
    record ? section(name, notes, () => read(record)) : null;
  return {
    dir,
    runId: record ? text(record.id) : null,
    task: record ? text(record.task) : null,
    status: record ? text(record.status) : null,
    taskType: record ? text(record.taskType?.type) : null,
    baseSha: record ? text(record.baseSha) : null,
    createdAt: record ? text(record.createdAt) : null,
    candidates: fromRecord('candidates', candidateViews) ?? [],
    ranking: fromRecord('ranking', rankingView),
    matrix: fromRecord('survival matrix', matrixView),
    dissent: section('dissent', notes, () => dissentRecords(files[DISSENT_FILE], record, notes)) ?? [],
    trail: section('decision trail', notes, () => trailRows(files[DECISIONS_FILE], notes)) ?? [],
    synthesis: fromRecord('synthesis', synthesisView),
    verdict: fromRecord('verdict', verdictView),
    reports: {
      synthesis: files[SYNTHESIS_REPORT] ?? null,
      reframe: files[REFRAME_REPORT] ?? null,
      verification: files[VERIFICATION_REPORT] ?? null,
    },
    notes,
  };
}
