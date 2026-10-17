/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setLogLevel } from '../shared/logger.js';
import { JsonCodeRunStore } from '../adapters/json-code-run-store.js';
import type { CodeRunRecord } from './code-service.js';
import { ledgerRows } from './ledger-service.js';

function entry(candidateId: string, status: 'PASS' | 'ISSUES' | 'BLOCKED', disqualified = false) {
  return { candidateId, status, key: { disqualified, newFailures: 0, survived: 0, counted: 0, penalties: 0 }, size: { lines: 1, files: 1 }, rank: 1, judgeTotal: null };
}

function verification(newFailures: string[], disqualified = false) {
  return { status: newFailures.length ? 'ISSUES' : 'PASS', sha: 'a'.repeat(40), install: null, gates: [], newFailures, integrity: [], disqualified, penalties: 1, errors: [] };
}

function candidate(candidateId: string, provider: string, extra: Record<string, unknown>) {
  return { candidateId, provider, model: null, status: 'ok', branch: `concilium/r1/${candidateId}`, worktree: '', headSha: 'b'.repeat(40), committed: true, diffStat: null, durationMs: 1000, usage: null, errors: [], brief: null, finalText: '', ...extra };
}

/** A verified, attacked, judged and synthesized run with one candidate per outcome. */
const RECORD = {
  version: 1, kind: 'code', id: 'r1', status: 'done', taskType: { type: 'bugfix', source: 'flag', reason: '--type' },
  rubric: { criteria: [{}, {}, {}], source: 'framer', framer: 'claude:claude-opus-5-5', frozenAt: '', sha256: 'x' },
  candidates: [
    candidate('claude', 'claude', { verification: verification([]), durationMs: 5000 }),
    candidate('codex', 'codex', { model: 'gpt-5.2', verification: verification(['test']) }),
    candidate('gemini', 'gemini', { verification: verification([]) }),
    candidate('claude-2', 'claude', { verification: verification([]) }),
    candidate('opencode', 'opencode', { verification: verification([], true) }),
    candidate('gemini-2', 'gemini', { verification: null, headSha: null, status: 'error' }),
  ],
  ranking: {
    winner: 'claude', reason: '', order: [entry('claude', 'PASS'), entry('claude-2', 'PASS'), entry('codex', 'ISSUES'), entry('gemini', 'PASS'), entry('opencode', 'ISSUES', true), entry('gemini-2', 'BLOCKED')],
    judgments: [{ status: 'PASS', candidates: ['claude', 'claude-2'], judge: 'codex', sameFamily: false, sameFamilyReason: null, rubricSha256: 'x', scores: [], totals: {}, reason: '' }],
  },
  adversarial: {
    testCommand: 'node t.js', matrix: {}, runs: [],
    adversaries: [
      { family: 'openai', provider: 'codex', model: null, lane: 'adv-openai', status: 'ok', durationMs: 700 },
      { family: 'google', provider: 'gemini', model: null, lane: 'adv-google', status: 'error', durationMs: 300 },
      { family: 'anthropic', provider: 'claude', model: null, lane: 'adv-anthropic', status: 'ok', durationMs: 200 },
    ],
    tests: [
      { id: 'openai-1', author: 'openai', validity: 'evidence', files: [], specClause: '' },
      { id: 'openai-2', author: 'openai', validity: 'quarantined', files: [], specClause: '' },
      { id: 'anthropic-1', author: 'anthropic', validity: 'vacuous', files: [], specClause: '' },
    ],
    survival: { claude: { counted: 1, survived: 1, failed: [] }, gemini: { counted: 1, survived: 0, failed: ['openai-1'] }, 'claude-2': { counted: 1, survived: 1, failed: [] } },
  },
  synthesis: {
    base: { candidateId: 'claude', headSha: 'c'.repeat(40), reason: '' }, picker: { provider: 'codex', sameFamily: false, sameFamilyReason: null },
    grafts: [
      { id: 'graft-1', candidateId: 'claude-2', status: 'applied', integrator: { provider: 'claude', model: null, durationMs: 400 } },
      { id: 'graft-2', candidateId: 'codex', status: 'rejected', integrator: { provider: 'claude', model: null, durationMs: 600 } },
    ],
  },
  prVerdict: { verdict: 'PASS+NOTES', verifier: { provider: 'gemini', model: 'gemini-3-pro', family: 'google', sameFamily: false, configured: true }, gates: { test: 'pass', lint: 'fail' }, tests: { 'openai-1': 'pass' } },
} as unknown as CodeRunRecord;

beforeAll(() => setLogLevel('error'));

describe('ledgerRows', () => {
  it('should give each candidate its outcome with its evidence and wall time', () => {
    const rows = ledgerRows(RECORD).filter((r) => r.role === 'implementer');

    expect(rows.map((r) => [r.candidateId, r.runner.spec, r.runner.family, r.outcome])).toEqual([
      ['claude', 'claude', 'anthropic', 'base'],
      ['codex', 'codex:gpt-5.2', 'openai', 'gate-failed'],
      ['gemini', 'gemini', 'google', 'killed-by-adversary'],
      ['claude-2', 'claude', 'anthropic', 'grafted'],
      ['opencode', 'opencode', null, 'dropout'],
      ['gemini-2', 'gemini', 'google', 'dropout'],
    ]);
    expect(rows[0]).toMatchObject({ runId: 'r1', taskType: 'bugfix', wallTimeMs: 5000, evidence: { verification: 'PASS', newFailures: 0, penalties: 1, testsSurvived: 1, testsCounted: 1, graftsApplied: 0 } });
    expect(rows[1].evidence).toMatchObject({ verification: 'ISSUES', newFailures: 1, graftsApplied: 0 });
    expect(rows[3].evidence).toMatchObject({ graftsApplied: 1 });
    expect(rows[4].evidence.verification).toBe('DISQUALIFIED');
    expect(rows[5].evidence.verification).toBeNull();
  });

  it("should take an OpenCode runner's family from its model id", () => {
    const routed = {
      ...RECORD,
      candidates: RECORD.candidates.map((c) => (c.candidateId === 'opencode' ? { ...c, model: 'openrouter/anthropic/claude-opus-4.6' } : c)),
    } as CodeRunRecord;
    const row = ledgerRows(routed).find((r) => r.role === 'implementer' && r.candidateId === 'opencode');
    expect(row?.runner).toEqual({ spec: 'opencode:openrouter/anthropic/claude-opus-4.6', provider: 'opencode', model: 'openrouter/anthropic/claude-opus-4.6', family: 'anthropic' });
  });

  it('should give one row per runner for the planner, adversaries, judge, integrator and verifier', () => {
    const rows = ledgerRows(RECORD).filter((r) => r.role !== 'implementer');

    expect(rows.map((r) => [r.role, r.runner.spec, r.outcome, r.evidence, r.wallTimeMs])).toEqual([
      ['planner', 'claude:claude-opus-5-5', 'framed', { criteria: 3 }, null],
      ['adversary', 'codex', 'landed', { tests: 2, valid: 1 }, 700],
      ['adversary', 'gemini', 'error', { tests: 0, valid: 0 }, 300],
      ['adversary', 'claude', 'missed', { tests: 1, valid: 0 }, 200],
      // codex judged the tie and picked the grafts: one row.
      ['judge', 'codex', 'judged', { ties: 1, blocked: 0, graftPicks: 1 }, null],
      ['integrator', 'claude', 'applied', { applied: 1, rejected: 1 }, 1000],
      ['verifier', 'gemini:gemini-3-pro', 'PASS+NOTES', { gatesFailed: 1, testsFailed: 0 }, null],
    ]);
  });

  it('should count the ranking winner as the base when there is no synthesis, and leave out roles that did not run', () => {
    const record = { ...RECORD, synthesis: undefined, adversarial: undefined, prVerdict: undefined, ranking: { ...RECORD.ranking, judgments: [] }, rubric: { ...RECORD.rubric, source: 'playbook' } } as CodeRunRecord;

    const rows = ledgerRows(record);

    expect(rows.filter((r) => r.role === 'implementer').map((r) => r.outcome)).toEqual(['base', 'gate-failed', 'outranked', 'outranked', 'dropout', 'dropout']);
    expect(rows.filter((r) => r.role !== 'implementer').map((r) => [r.role, r.outcome])).toEqual([['planner', 'fallback']]);
  });
});

describe('JsonCodeRunStore list', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'concilium-ledger-test-'));
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it('should list the saved code runs by id and skip factories, plan runs and unreadable files', async () => {
    const store = new JsonCodeRunStore(dataDir);
    await store.save({ ...RECORD, id: 'r2' });
    await store.save(RECORD);
    mkdirSync(join(dataDir, 'runs', 'f1'));
    writeFileSync(join(dataDir, 'runs', 'f1', 'factory.json'), '{}');
    mkdirSync(join(dataDir, 'runs', 'r3'));
    writeFileSync(join(dataDir, 'runs', 'r3', 'run.json'), 'not json');
    writeFileSync(join(dataDir, 'runs', 'plan.json'), '{}');

    expect((await store.list()).map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(await new JsonCodeRunStore(join(dataDir, 'missing')).list()).toEqual([]);
  });
});
