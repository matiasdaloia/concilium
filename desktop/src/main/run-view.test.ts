/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rankCells, rankingLine } from '../shared/run-view';
import { parseRunDir, RUN_FILES, type RunFiles } from './run-view';

/** A run directory `concilium code` and `concilium verify-pr` wrote on fake CLIs: `desktop/scripts/make-run-fixture.mjs`. */
const FIXTURE = fileURLToPath(new URL('./__fixtures__/code-run', import.meta.url));

function fixtureFiles(): RunFiles {
  const files: RunFiles = {};
  for (const name of RUN_FILES) {
    try {
      files[name] = readFileSync(path.join(FIXTURE, name), 'utf8');
    } catch {
      // The fixture has no reframe.md.
    }
  }
  return files;
}

const record = () => JSON.parse(fixtureFiles()['run.json'] ?? '{}');

describe('parseRunDir', () => {
  it('should show the candidates, ranking, matrix, dissent, trail, synthesis and verdict of a CLI run', () => {
    const view = parseRunDir(FIXTURE, fixtureFiles());

    expect(view.notes).toEqual([]);
    expect(view).toMatchObject({ runId: record().id, task: 'sum must reject non-numbers', status: 'done', taskType: 'feature' });
    expect(view.candidates.map((c) => [c.candidateId, c.runner, c.status, c.report, c.diff])).toEqual([
      ['claude', 'claude', 'ok', 'ISSUES', '2 files, +3 -1'],
      ['codex', 'codex', 'ok', 'PASS', '1 files, +4 -1'],
    ]);
    expect(view.candidates[0].reason).toBe('lint: fail, passes on the base');
    expect(view.ranking).toMatchObject({ winner: 'codex', reason: 'best on the evidence' });
    expect(view.ranking?.rows.map(rankCells)).toEqual([
      ['1', 'codex', 'PASS', '0', '1/1', '0', '5 lines, 1 files', '-'],
      ['2', 'claude', 'ISSUES', '1', 'none counted', '0', '4 lines, 2 files', '-'],
    ]);
    expect(view.matrix).toEqual({
      lanes: ['base', 'claude', 'codex'],
      tests: [
        { id: 'anthropic-1', author: 'anthropic', validity: 'evidence', specClause: 'sum rejects non-numbers', cells: { base: 'fail', claude: 'pass', codex: 'pass' } },
        { id: 'openai-1', author: 'openai', validity: 'own-family-only', specClause: 'sum rejects non-numbers', cells: { base: 'fail', claude: 'fail', codex: 'pass' } },
      ],
      survival: [{ candidateId: 'claude', text: 'none counted' }, { candidateId: 'codex', text: '1/1' }],
    });
    expect(view.dissent.map((d) => [d.id, d.source, d.resolution])).toEqual([['dissent-1', 'same-family-judge', 'accepted-risk']]);
    expect(view.trail.map((r) => r.step)).toEqual([
      'task-type', 'rubric', 'candidates', 'gate-plan', 'verification', 'verification', 'adversarial', 'ranking', 'base-pick', 'graft', 'divergence', 'dissent', 'mergeable',
    ]);
    expect(view.synthesis).toMatchObject({ skipped: null, base: 'codex', mergeable: true, mergeBlock: null, grafts: [{ id: 'graft-1', candidateId: 'claude', status: 'applied' }], dropouts: [] });
    expect(view.verdict).toMatchObject({ verdict: 'PASS', verifier: 'claude', sameFamilyReason: expect.stringContaining('outside the author families') });
    expect(view.reports.synthesis).toContain('## Ranking');
    expect(view.reports.verification).toContain('## Verdict: PASS');
    expect(view.reports.reframe).toBeNull();
  });

  it('should keep the reports and say so when run.json is missing, not JSON, or not a code run', () => {
    const missing = parseRunDir('/runs/x', { ...fixtureFiles(), 'run.json': undefined });
    expect(missing).toMatchObject({ runId: null, ranking: null, candidates: [], matrix: null, synthesis: null, verdict: null });
    expect(missing.notes).toEqual(['no run.json: showing only the reports']);
    expect(missing.reports.synthesis).toContain('## Ranking');
    // The dissent and the trail have their own files.
    expect(missing.dissent).toHaveLength(1);
    expect(missing.trail).toHaveLength(13);

    expect(parseRunDir('/runs/x', { 'run.json': '{"kind": "code", ' }).notes[0]).toMatch(/^run.json is not JSON: /);
    expect(parseRunDir('/runs/x', { 'run.json': JSON.stringify({ version: 1, kind: 'factory', id: 'f' }) }).notes)
      .toEqual(['run.json is not a code run (kind "factory")']);
  });

  it('should read what it can of a newer or partial record instead of failing', () => {
    const newer = parseRunDir('/runs/x', { 'run.json': JSON.stringify({ ...record(), version: 2 }) });
    expect(newer.notes).toEqual(['run.json is version 2; this viewer knows version 1 and shows what it can read']);
    expect(newer.ranking?.rows.map((r) => r.candidateId)).toEqual(['codex', 'claude']);

    // An older run: no verification, no adversarial round, no synthesis, no trail, no verdict, odd values.
    const old = parseRunDir('/runs/x', {
      'run.json': JSON.stringify({
        version: 1, kind: 'code', id: 'old', task: 't', status: 'done',
        candidates: [{ candidateId: 'claude', provider: 'claude', status: 'ok', diffStat: null }, 'junk', null],
        ranking: { order: [{ candidateId: 'claude', status: 'PASS', rank: 1, key: { counted: 'two' } }], winner: 'claude', reason: 'r' },
        dissent: { path: null, records: [{ id: 'dissent-1', source: 'base-pick', summary: 's', resolution: 'open' }, { id: 3 }] },
      }),
    });
    expect(old.notes).toEqual([]);
    expect(old.candidates).toEqual([{ candidateId: 'claude', runner: 'claude', status: 'ok', branch: '', headSha: null, diff: null, report: null, reason: null }]);
    expect(old.ranking?.rows.map(rankCells)).toEqual([['1', 'claude', 'PASS', '0', 'none counted', '0', '0 lines, 0 files', '-']]);
    expect(old).toMatchObject({ matrix: null, synthesis: null, verdict: null, trail: [] });
    // Without dissent.json, the records on run.json; malformed ones are left out.
    expect(old.dissent.map((d) => d.id)).toEqual(['dissent-1']);
  });

  it('should note a decisions.tsv or dissent.json it does not recognise', () => {
    const view = parseRunDir('/runs/x', { 'decisions.tsv': 'when\twhat\n1\t2\n', 'dissent.json': JSON.stringify({ version: 9, records: [] }) });
    expect(view.notes).toEqual([
      'no run.json: showing only the reports',
      'dissent.json is version 9; this viewer knows version 1',
      'decisions.tsv:1: the header is not ts, event, step, decision, chosen, alternatives, evidence, reason',
      'decisions.tsv:2: 2 columns, expected 8',
    ]);
    expect(view.trail).toEqual([]);
  });
});

describe('rankingLine', () => {
  it('should write each rendered ranking row as the table line synthesis.md has for it', () => {
    const synthesis = readFileSync(path.join(FIXTURE, 'synthesis.md'), 'utf8');
    const table = synthesis.split('\n').filter((line) => /^\| \d+ \| /.test(line));
    const view = parseRunDir(FIXTURE, fixtureFiles());

    expect(table).toHaveLength(2);
    expect(view.ranking?.rows.map((row) => rankingLine(rankCells(row)))).toEqual(table);
    expect(synthesis).toContain(`Winner: \`${view.ranking?.winner}\`: ${view.ranking?.reason}.`);
  });
});
