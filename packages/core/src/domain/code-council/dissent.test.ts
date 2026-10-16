/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import type { AdversarialTest } from '../verification/adversarial.js';
import { blockingDissent, collectDissent, dissentMarkdown, warningDissent, withDissent, type DissentInput } from './dissent.js';
import type { Judgment } from './judging.js';
import type { RankEntry, Ranking } from './ranking.js';
import type { Graft, Synthesis } from './synthesis.js';

const HEADS = { claude: 'c'.repeat(40), codex: 'd'.repeat(40) };
const RUBRIC = 'f'.repeat(64);

function entry(candidateId: string, rank: number): RankEntry {
  return { candidateId, status: 'PASS', key: { disqualified: false, newFailures: 0, survived: 1, counted: 1, penalties: 0 }, size: { lines: 2, files: 1 }, rank, judgeTotal: null };
}

function judgment(judge: string, totals: Record<string, number>, extra: Partial<Judgment> = {}): Judgment {
  return {
    status: 'PASS', candidates: ['claude', 'codex'], judge, sameFamily: false, sameFamilyReason: null, rubricSha256: RUBRIC,
    scores: Object.entries(totals).map(([candidateId, score]) => ({ candidateId, criterion: 'clarity', score, reason: `${candidateId} reads ${score > 5 ? 'well' : 'poorly'}` })),
    totals, reason: 'scored', ...extra,
  };
}

function ranking(judgments: Judgment[], winner = 'claude', reason = 'tie broken by smallest diff: claude, codex tie on the evidence and the judge scored them the same; claude changes 2 lines in 1 file'): Ranking {
  return { order: [entry('claude', 1), entry('codex', 2)], winner, reason, judgments };
}

const test = (id: string, validity: AdversarialTest['validity'], specClause = 'sum adds'): AdversarialTest => ({ id, author: id.split('-')[0], files: [`${id}.test.js`], specClause, validity });

function graft(id: string, evidence: Graft['evidence'], extra: Partial<Graft> = {}): Graft {
  return {
    id, candidateId: 'codex', files: ['sum.js'], hunk: null, instruction: 'Use unary plus.', why: 'Shorter.', status: 'rejected',
    commitSha: 'a'.repeat(40), revertSha: 'b'.repeat(40), reason: evidence.map((e) => e.detail).join('; '), evidence,
    integrator: { provider: 'claude', model: null, status: 'ok', durationMs: 1, errors: [], finalText: '', brief: null }, ...extra,
  };
}

function synthesis(extra: Partial<Synthesis> = {}): Synthesis {
  return {
    base: { candidateId: 'claude', headSha: HEADS.claude, reason: 'best on the evidence' }, branch: 'concilium/r1/integration', worktree: '/w', headSha: 'e'.repeat(40),
    picker: { provider: 'gemini', sameFamily: false, sameFamilyReason: null }, notes: [], grafts: [], dropouts: [],
    checks: { sha: 'e'.repeat(40), gates: { test: 'pass' }, tests: {} }, patchPath: '/run/result.patch', synthesisPath: '/run/synthesis.md',
    mergeable: true, mergeCheck: { applies: true, targetSha: HEADS.claude, output: '' }, ...extra,
  };
}

const input = (extra: Partial<DissentInput>): DissentInput => ({ ranking: ranking([]), heads: HEADS, tests: [], ...extra });

describe('collectDissent', () => {
  it('should record a judge that prefers another base with both rationales and evidence pointers, overruled by the evidence', () => {
    const records = collectDissent(input({ ranking: ranking([judgment('gemini', { claude: 3, codex: 9 })]) }));

    expect(records).toEqual([{
      id: 'dissent-1',
      source: 'base-pick',
      summary: 'gemini prefers codex as the base; the pick is claude',
      evidence: [
        { kind: 'judgment', ref: 'gemini' }, { kind: 'rubric', ref: `sha256:${RUBRIC}` },
        { kind: 'commit', ref: 'claude', sha: HEADS.claude }, { kind: 'commit', ref: 'codex', sha: HEADS.codex },
      ],
      acceptanceClause: null,
      rationales: {
        pick: 'claude: tie broken by smallest diff: claude, codex tie on the evidence and the judge scored them the same; claude changes 2 lines in 1 file',
        dissent: 'codex totals 9 against 3 for claude; clarity 9: codex reads well',
      },
      resolution: 'overruled',
      resolutionReason: `the evidence ranks claude first (0 new gate failures, survival 1/1, 0 penalties) at ${HEADS.claude}: tie broken by smallest diff: claude, codex tie on the evidence and the judge scored them the same; claude changes 2 lines in 1 file`,
    }]);
  });

  it('should record no base-pick when the judge tops the pick, ties it at the top, is BLOCKED, or there is no winner', () => {
    expect(collectDissent(input({ ranking: ranking([judgment('gemini', { claude: 9, codex: 3 })]) }))).toEqual([]);
    expect(collectDissent(input({ ranking: ranking([judgment('gemini', { claude: 9, codex: 9 })]) }))).toEqual([]);
    expect(collectDissent(input({ ranking: ranking([judgment('gemini', { claude: 3, codex: 9 }, { status: 'BLOCKED' })]) }))).toEqual([]);
    expect(collectDissent(input({ ranking: { ...ranking([judgment('gemini', { claude: 3, codex: 9 })]), winner: null } }))).toEqual([]);
  });

  it('should keep a valid test the integration head still fails open on its acceptance line, and a quarantined test as a warning', () => {
    const tests = [test('openai-1', 'evidence', 'sum rejects letters'), test('google-1', 'quarantined', 'sum is fast'), test('anthropic-1', 'regression-guard')];
    const s = synthesis({ checks: { sha: 'e'.repeat(40), gates: { test: 'pass' }, tests: { 'openai-1': 'fail', 'anthropic-1': 'pass' } } });
    const records = collectDissent(input({ tests, synthesis: s }));

    expect(records).toEqual([
      {
        id: 'dissent-1', source: 'adversarial-test', summary: 'the integration head is fail on adversarial test openai-1 by openai',
        evidence: [{ kind: 'test', ref: 'openai-1' }, { kind: 'file', ref: 'openai-1.test.js' }, { kind: 'commit', ref: 'concilium/r1/integration', sha: 'e'.repeat(40) }],
        acceptanceClause: 'sum rejects letters', resolution: 'open', resolutionReason: null,
      },
      expect.objectContaining({
        id: 'dissent-2', source: 'quarantined-test', acceptanceClause: 'sum is fast', resolution: 'warning',
        resolutionReason: 'quarantined: fails on base and every candidate; not classified by a judge',
        evidence: [{ kind: 'test', ref: 'google-1' }, { kind: 'file', ref: 'google-1.test.js' }],
      }),
    ]);
    expect(blockingDissent(records).map((d) => d.id)).toEqual(['dissent-1']);
    expect(warningDissent(records).map((d) => d.id)).toEqual(['dissent-2']);
  });

  it('should overrule a rejected graft with the checks that failed after it, and keep one the integrator never delivered open', () => {
    const broke = graft('graft-1', [{ kind: 'gate', detail: 'gate test passed before the graft and is fail after it', sha: 'a'.repeat(40) }]);
    const empty = graft('graft-2', [{ kind: 'integrator', detail: 'the integrator made no change' }], { commitSha: null, revertSha: null });
    const records = collectDissent(input({ synthesis: synthesis({ grafts: [broke, { ...broke, id: 'graft-3', status: 'applied' }, empty] }) }));

    expect(records).toEqual([
      {
        id: 'dissent-1', source: 'rejected-graft', summary: 'graft-1 from codex (sum.js) was rejected: Use unary plus.',
        evidence: [
          { kind: 'commit', ref: 'graft-1', sha: 'a'.repeat(40) }, { kind: 'commit', ref: 'revert of graft-1', sha: 'b'.repeat(40) },
          { kind: 'commit', ref: 'codex', sha: HEADS.codex }, { kind: 'file', ref: 'sum.js' },
        ],
        acceptanceClause: null, resolution: 'overruled',
        resolutionReason: `gate test passed before the graft and is fail after it at ${'a'.repeat(40)}; reverted by ${'b'.repeat(40)}`,
      },
      expect.objectContaining({ id: 'dissent-2', summary: 'graft-2 from codex (sum.js) was rejected: Use unary plus. (the integrator made no change)', resolution: 'open', resolutionReason: null }),
    ]);
    // Every overruled record says why and points at evidence.
    for (const d of records.filter((d) => d.resolution === 'overruled')) {
      expect(d.resolutionReason).toMatch(/[0-9a-f]{40}/);
      expect(d.evidence.length).toBeGreaterThan(0);
    }
    expect(blockingDissent(records)).toEqual([]);
  });

  it('should record a rubric criterion whose scores spread past the limit across judgments of the same tie', () => {
    const spread = collectDissent(input({ ranking: ranking([judgment('gemini', { claude: 9, codex: 5 }), judgment('opencode', { claude: 2, codex: 5 })]) }));
    // opencode's totals also put codex on top, so it dissents from the pick too.
    expect(spread.map((d) => d.source)).toEqual(['base-pick', 'rubric-spread']);
    expect(spread.filter((d) => d.source === 'rubric-spread')).toEqual([expect.objectContaining({
      source: 'rubric-spread', resolution: 'open', acceptanceClause: null,
      summary: 'the judges score claude on clarity 9 (gemini: claude reads well), 2 (opencode: claude reads poorly), a spread of 7',
    })]);
    expect(collectDissent(input({ ranking: ranking([judgment('gemini', { claude: 9, codex: 5 }), judgment('opencode', { claude: 6, codex: 5 })]) }))).toEqual([]);
  });

  it('should note a same-family judge and graft picker as accepted risks with their reasons', () => {
    const records = collectDissent(input({
      ranking: ranking([judgment('claude', { claude: 9, codex: 3 }, { sameFamily: true, sameFamilyReason: 'no CLI outside the tied families (anthropic, openai) is usable, so claude judges' })]),
      synthesis: synthesis({ picker: { provider: 'claude', sameFamily: true, sameFamilyReason: 'no other CLI names the grafts' } }),
    }));
    expect(records.map((d) => [d.source, d.resolution, d.resolutionReason])).toEqual([
      ['same-family-judge', 'accepted-risk', 'no CLI outside the tied families (anthropic, openai) is usable, so claude judges'],
      ['same-family-judge', 'accepted-risk', 'no other CLI names the grafts'],
    ]);
  });
});

describe('withDissent', () => {
  it('should take the mergeable label away only for open dissent on an acceptance line', () => {
    const failing = synthesis({ checks: { sha: 'e'.repeat(40), gates: { test: 'pass' }, tests: { 'openai-1': 'fail' } } });
    const open = collectDissent(input({ tests: [test('openai-1', 'evidence', 'sum rejects letters')], synthesis: failing }));
    expect(withDissent(synthesis(), open)).toMatchObject({ mergeable: false, mergeBlock: 'open dissent on acceptance lines: dissent-1 ("sum rejects letters")', patchPath: '/run/result.patch' });

    // A quarantined test is a warning: it is recorded but leaves the label alone.
    const quarantined = collectDissent(input({ tests: [test('google-1', 'quarantined', 'sum is fast')], synthesis: synthesis() }));
    expect(withDissent(synthesis(), quarantined)).toEqual(synthesis());

    const overruled = collectDissent(input({ ranking: ranking([judgment('gemini', { claude: 3, codex: 9 })]) }));
    expect(withDissent(synthesis(), overruled)).toEqual(synthesis());
    expect(withDissent({ ...synthesis(), skipped: 'fewer than 2 candidates' }, open).mergeBlock).toBeUndefined();
  });
});

describe('dissentMarkdown', () => {
  it('should list open dissent first with its line and evidence, then the rest with their resolution', () => {
    const records = collectDissent(input({
      ranking: ranking([judgment('gemini', { claude: 3, codex: 9 })]), tests: [test('openai-1', 'evidence', 'sum rejects letters'), test('google-1', 'quarantined', 'sum is fast')],
      synthesis: synthesis({ checks: { sha: 'e'.repeat(40), gates: { test: 'pass' }, tests: { 'openai-1': 'fail' } } }),
    }));
    const md = dissentMarkdown(records).join('\n');
    expect(md).toMatch(/^## Dissent\n\n1 open of 3, also in `dissent.json`. Open dissent on an acceptance line \(dissent-2\) keeps the patch from being labelled mergeable. 1 warning \(dissent-3\) does not.\n/);
    expect(md.indexOf('**dissent-2** open, adversarial-test')).toBeLessThan(md.indexOf('**dissent-3** warning, quarantined-test'));
    expect(md.indexOf('**dissent-3** warning, quarantined-test')).toBeLessThan(md.indexOf('**dissent-1** overruled, base-pick'));
    expect(md).toContain('  Acceptance line: "sum is fast".');
    expect(md).toContain('  Warning: quarantined: fails on base and every candidate; not classified by a judge.');
    expect(md).toContain('  Pick: claude: tie broken by smallest diff');
    expect(md).toContain('  Dissent: codex totals 9 against 3 for claude; clarity 9: codex reads well.');
    expect(md).toContain(`commit \`codex\` at \`${HEADS.codex}\``);
    expect(md).toContain('  Overruled: the evidence ranks claude first');
    expect(dissentMarkdown([])).toEqual(['## Dissent', '', 'None.', '']);
  });
});
