/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { getProviderInfo } from '../domain/agent/providers.js';
import { implementerOutcome, type LedgerRow, type Runner } from '../domain/code-council/ledger.js';
import { contends } from '../domain/code-council/ranking.js';
import { specAgent } from '../domain/roles/roles.js';
import type { CodeRunRecord } from './code-service.js';

function runner(provider: string, model: string | null): Runner {
  return { spec: model ? `${provider}:${model}` : provider, provider, model, family: getProviderInfo(provider)?.family ?? null };
}

function specRunner(spec: string): Runner {
  const agent = specAgent(spec);
  return runner(agent.provider, agent.model ?? null);
}

/** Rows keyed by runner spec, merged with `merge` when the runner already has one. */
function byRunner<T extends { runner: Runner }>(items: T[], merge: (a: T, b: T) => T): T[] {
  const rows = new Map<string, T>();
  for (const item of items) {
    const prev = rows.get(item.runner.spec);
    rows.set(item.runner.spec, prev ? merge(prev, item) : item);
  }
  return [...rows.values()];
}

/**
 * The learning ledger rows of one saved code run (see `LedgerRow`), derived from the record alone, so they always
 * agree with its `decisions.tsv`: one per candidate, then the planner, each adversary, each judge (tie judges and
 * the graft picker), each integrator and the PR verifier.
 */
export function ledgerRows(record: CodeRunRecord): LedgerRow[] {
  const at = { runId: record.id, taskType: record.taskType.type };
  const base = record.synthesis?.base?.candidateId ?? record.ranking.winner;
  const grafts = record.synthesis?.grafts ?? [];
  const rows: LedgerRow[] = [];

  for (const c of record.candidates) {
    const entry = record.ranking.order.find((e) => e.candidateId === c.candidateId);
    const v = c.verification ?? null;
    const survival = record.adversarial?.survival[c.candidateId];
    const evidence = {
      verification: v === null ? null : v.disqualified ? 'DISQUALIFIED' as const : v.status,
      newFailures: v?.newFailures.length ?? 0,
      penalties: v?.penalties ?? 0,
      testsSurvived: survival?.survived ?? 0,
      testsCounted: survival?.counted ?? 0,
      graftsApplied: grafts.filter((g) => g.candidateId === c.candidateId && g.status === 'applied').length,
    };
    rows.push({
      ...at, role: 'implementer', candidateId: c.candidateId, runner: runner(c.provider, c.model), wallTimeMs: c.durationMs, evidence,
      outcome: implementerOutcome({ ...evidence, isBase: c.candidateId === base, dropped: !entry || !contends(entry) }),
    });
  }

  if (record.rubric.framer) {
    rows.push({
      ...at, role: 'planner', runner: specRunner(record.rubric.framer), wallTimeMs: null,
      outcome: record.rubric.source === 'framer' ? 'framed' : 'fallback', evidence: { criteria: record.rubric.criteria.length },
    });
  }

  for (const a of record.adversarial?.adversaries ?? []) {
    const tests = record.adversarial!.tests.filter((t) => t.author === a.family);
    const valid = tests.filter((t) => t.validity === 'evidence' || t.validity === 'regression-guard').length;
    rows.push({
      ...at, role: 'adversary', runner: runner(a.provider, a.model), wallTimeMs: a.durationMs,
      outcome: valid > 0 ? 'landed' : a.status !== 'ok' ? 'error' : 'missed', evidence: { tests: tests.length, valid },
    });
  }

  const picker = record.synthesis?.picker;
  const judges = [
    ...record.ranking.judgments.flatMap((j) => (j.judge ? [{ runner: specRunner(j.judge), ties: 1, blocked: j.status === 'BLOCKED' ? 1 : 0, graftPicks: 0 }] : [])),
    ...(picker ? [{ runner: specRunner(picker.provider), ties: 0, blocked: 0, graftPicks: 1 }] : []),
  ];
  for (const j of byRunner(judges, (a, b) => ({ runner: a.runner, ties: a.ties + b.ties, blocked: a.blocked + b.blocked, graftPicks: a.graftPicks + b.graftPicks }))) {
    rows.push({
      ...at, role: 'judge', runner: j.runner, wallTimeMs: null,
      outcome: j.blocked > 0 ? 'blocked' : 'judged', evidence: { ties: j.ties, blocked: j.blocked, graftPicks: j.graftPicks },
    });
  }

  const integrators = grafts.map((g) => ({
    runner: runner(g.integrator.provider, g.integrator.model), wallTimeMs: g.integrator.durationMs,
    applied: g.status === 'applied' ? 1 : 0, rejected: g.status === 'rejected' ? 1 : 0,
  }));
  for (const i of byRunner(integrators, (a, b) => ({ runner: a.runner, wallTimeMs: a.wallTimeMs + b.wallTimeMs, applied: a.applied + b.applied, rejected: a.rejected + b.rejected }))) {
    rows.push({
      ...at, role: 'integrator', runner: i.runner, wallTimeMs: i.wallTimeMs,
      outcome: i.applied > 0 ? 'applied' : 'rejected', evidence: { applied: i.applied, rejected: i.rejected },
    });
  }

  const verdict = record.prVerdict;
  if (verdict?.verifier) {
    const failing = (cells: Record<string, string>) => Object.values(cells).filter((c) => c !== 'pass').length;
    rows.push({
      ...at, role: 'verifier', runner: runner(verdict.verifier.provider, verdict.verifier.model), wallTimeMs: null,
      outcome: verdict.verdict, evidence: { gatesFailed: failing(verdict.gates), testsFailed: failing(verdict.tests) },
    });
  }
  return rows;
}
