/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { crossFamilySet, implementerOutcome, ledgerStats, type ImplementerFacts, type ImplementerOutcome, type LedgerRow, type Runner } from './ledger.js';
import type { TaskType } from './playbooks.js';

const FAMILIES: Record<string, string | null> = { claude: 'anthropic', codex: 'openai', gemini: 'google', opencode: null };

function runner(spec: string): Runner {
  const [provider, model] = spec.split(':');
  return { spec, provider, model: model ?? null, family: FAMILIES[provider] };
}

function implementer(runId: string, spec: string, outcome: ImplementerOutcome, taskType: TaskType = 'feature', wallTimeMs: number | null = 1000): LedgerRow {
  return {
    runId, taskType, role: 'implementer', candidateId: spec.split(':')[0], runner: runner(spec), wallTimeMs, outcome,
    evidence: { verification: 'PASS', newFailures: 0, penalties: 0, testsSurvived: 0, testsCounted: 0, graftsApplied: 0 },
  };
}

/** `n` runs of `type`, each with one row per spec; the first spec is the base in `wins` of them, the others are outranked. */
function runs(n: number, specs: string[], wins: number, type: TaskType = 'feature'): LedgerRow[] {
  return Array.from({ length: n }, (_, i) => specs.map((spec, j) => implementer(`${type}-${i}`, spec, j === 0 && i < wins ? 'base' : j === 1 && i >= wins ? 'base' : 'outranked', type))).flat();
}

const NONE: ImplementerFacts = { isBase: false, graftsApplied: 0, dropped: false, newFailures: 0, testsSurvived: 0, testsCounted: 0 };

describe('implementerOutcome', () => {
  it('should take the first outcome that applies: base, grafted, dropout, gate-failed, killed-by-adversary, outranked', () => {
    expect(implementerOutcome({ ...NONE, isBase: true, newFailures: 1, dropped: true })).toBe('base');
    expect(implementerOutcome({ ...NONE, graftsApplied: 1, newFailures: 2 })).toBe('grafted');
    expect(implementerOutcome({ ...NONE, dropped: true, newFailures: 1 })).toBe('dropout');
    expect(implementerOutcome({ ...NONE, newFailures: 1, testsCounted: 2, testsSurvived: 0 })).toBe('gate-failed');
    expect(implementerOutcome({ ...NONE, testsCounted: 2, testsSurvived: 1 })).toBe('killed-by-adversary');
    expect(implementerOutcome({ ...NONE, testsCounted: 2, testsSurvived: 2 })).toBe('outranked');
    expect(implementerOutcome(NONE)).toBe('outranked');
  });
});

describe('ledgerStats', () => {
  it('should count wins and outcomes per task type and runner, best win rate first', () => {
    const rows = [
      implementer('r1', 'claude', 'base', 'feature', 1000),
      implementer('r1', 'codex', 'gate-failed', 'feature', 3000),
      implementer('r2', 'claude', 'grafted', 'feature', 2000),
      implementer('r2', 'codex', 'base', 'feature', null),
      implementer('r3', 'codex', 'base', 'feature', 1000),
      implementer('r3', 'claude', 'dropout', 'feature', 3000),
      implementer('r4', 'claude', 'base', 'bugfix'),
    ];

    const stats = ledgerStats(rows, 1);

    expect(stats.runs).toBe(4);
    expect(stats.byRunner.map((s) => [s.taskType, s.runner.spec, s.runs, s.wins, s.winRate, s.meanWallTimeMs])).toEqual([
      ['bugfix', 'claude', 1, 1, 1, 1000],
      ['feature', 'codex', 3, 2, 2 / 3, 2000],
      ['feature', 'claude', 3, 1, 1 / 3, 2000],
    ]);
    expect(stats.byRunner[1].outcomes).toEqual({ base: 2, grafted: 0, dropout: 0, 'gate-failed': 1, 'killed-by-adversary': 0, outranked: 0 });
    expect(stats.byRunner[2].outcomes).toEqual({ base: 1, grafted: 1, dropout: 1, 'gate-failed': 0, 'killed-by-adversary': 0, outranked: 0 });
  });

  it('should count the other roles by outcome per runner, apart from the win rate', () => {
    const rows: LedgerRow[] = [
      implementer('r1', 'claude', 'base'),
      { runId: 'r1', taskType: 'feature', role: 'judge', runner: runner('gemini'), wallTimeMs: null, outcome: 'judged', evidence: { ties: 1, blocked: 0, graftPicks: 1 } },
      { runId: 'r2', taskType: 'feature', role: 'judge', runner: runner('gemini'), wallTimeMs: null, outcome: 'blocked', evidence: { ties: 1, blocked: 1, graftPicks: 0 } },
      { runId: 'r2', taskType: 'feature', role: 'verifier', runner: runner('codex'), wallTimeMs: null, outcome: 'PASS', evidence: { gatesFailed: 0, testsFailed: 0 } },
    ];

    const stats = ledgerStats(rows, 1);

    expect(stats.byRunner.map((s) => s.runner.spec)).toEqual(['claude']);
    expect(stats.byRole).toEqual([
      { role: 'judge', runner: runner('gemini'), runs: 2, outcomes: { judged: 1, blocked: 1 } },
      { role: 'verifier', runner: runner('codex'), runs: 1, outcomes: { PASS: 1 } },
    ]);
  });

  it('should suggest nothing for a task type below the minimum sample, and default to 10 runs', () => {
    const stats = ledgerStats(runs(9, ['claude', 'codex'], 6));

    expect(stats.minSample).toBe(10);
    expect(stats.suggestions).toEqual([]);
    expect(stats.withheld).toEqual([{ taskType: 'feature', runs: 9, reason: '9 runs, fewer than the minimum sample of 10' }]);
  });

  it('should suggest the best runner of each family, best win rate first, once a task type has the minimum sample', () => {
    const rows = [
      ...runs(10, ['codex', 'claude'], 3),
      ...Array.from({ length: 10 }, (_, i) => implementer(`feature-${i}`, 'codex:gpt-5.2', i < 2 ? 'grafted' : 'outranked')),
      ...runs(10, ['claude', 'gemini'], 10, 'bugfix'),
    ];

    const stats = ledgerStats(rows);

    expect(stats.suggestions.map((s) => [s.taskType, s.runs, s.candidates.map((r) => r.spec)])).toEqual([
      ['bugfix', 10, ['claude', 'gemini']],
      // claude wins 7 of 10, codex 3; codex:gpt-5.2 never wins, so codex alone stands for openai.
      ['feature', 10, ['claude', 'codex']],
    ]);
    expect(stats.withheld).toEqual([]);
  });

  it('should withhold the suggestion when the runners cover one family, however many runs there are', () => {
    const rows = [...runs(12, ['claude', 'claude:claude-opus-5-5'], 6), ...runs(12, ['claude', 'opencode'], 12, 'refactor')];

    const stats = ledgerStats(rows);

    expect(stats.suggestions).toEqual([]);
    expect(stats.withheld).toEqual([
      { taskType: 'feature', runs: 12, reason: 'its runners cover fewer than two model families, and a panel stays cross-family' },
      // OpenCode has no known family, so it never counts as the second one.
      { taskType: 'refactor', runs: 12, reason: 'its runners cover fewer than two model families, and a panel stays cross-family' },
    ]);
  });

  it('should never suggest a candidate set of fewer than two families', () => {
    const specs = ['claude', 'claude:claude-opus-5-5', 'codex', 'codex:gpt-5.2', 'gemini', 'opencode'];
    // Every subset of runners, each with a different winner and win count.
    for (let mask = 1; mask < 1 << specs.length; mask++) {
      const panel = specs.filter((_, i) => mask & (1 << i));
      for (let wins = 0; wins <= 10; wins += 5) {
        for (const set of [...ledgerStats(runs(10, panel, wins)).suggestions, ...ledgerStats(runs(10, panel, wins), 1).suggestions].map((s) => s.candidates)) {
          const families = set.map((r) => r.family);
          expect(families.every((f) => f !== null)).toBe(true);
          expect(new Set(families).size).toBe(set.length);
          expect(set.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});

describe('crossFamilySet', () => {
  it('should keep the first runner of each known family, in order, and refuse fewer than two families', () => {
    expect(crossFamilySet(['codex', 'claude', 'codex:gpt-5.2', 'opencode', 'gemini'].map(runner))!.map((r) => r.spec)).toEqual(['codex', 'claude', 'gemini']);
    expect(crossFamilySet(['claude', 'claude:claude-opus-5-5', 'opencode'].map(runner))).toBeNull();
    expect(crossFamilySet([])).toBeNull();
  });
});
