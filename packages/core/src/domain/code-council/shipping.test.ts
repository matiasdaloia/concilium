/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import type { Dissent } from './dissent.js';
import {
  authorFamilies,
  decideVerdict,
  parseReview,
  pickVerifier,
  prBody,
  prTitle,
  verdictState,
  verificationMarkdown,
  type PrVerdict,
} from './shipping.js';
import type { Graft, Synthesis } from './synthesis.js';

const HEAD = 'a'.repeat(40);
const candidates = [
  { candidateId: 'claude', provider: 'claude' },
  { candidateId: 'codex', provider: 'codex' },
  { candidateId: 'opencode', provider: 'opencode' },
];

function graft(candidateId: string, integrator: string, commitSha: string | null): Graft {
  return {
    id: 'graft-1', candidateId, files: ['a.js'], hunk: null, instruction: 'take it', why: 'better', status: commitSha ? 'applied' : 'rejected',
    commitSha, revertSha: null, reason: '', evidence: [],
    integrator: { provider: integrator, model: null, status: 'ok', durationMs: 0, errors: [], finalText: '', brief: null },
  };
}

function synthesis(grafts: Graft[]): Synthesis {
  return {
    base: { candidateId: 'claude', headSha: HEAD, reason: 'best' }, branch: 'concilium/r/integration', worktree: null, headSha: HEAD, picker: null,
    notes: [], grafts, dropouts: [], checks: null, patchPath: null, synthesisPath: null, mergeable: true, mergeCheck: null,
  };
}

function verdict(overrides: Partial<PrVerdict> = {}): PrVerdict {
  return {
    verdict: 'PASS', reason: 'all good', notes: [], verifier: { provider: 'gemini', family: 'google' }, authorFamilies: ['anthropic'],
    branch: 'concilium/r/integration', headSha: HEAD, baseSha: 'b'.repeat(40), patchId: 'c'.repeat(40), gates: { test: 'pass' }, tests: {},
    review: { status: 'PASS', text: 'VERDICT: PASS' }, verifiedAt: '2026-10-17T10:00:00.000Z', reportPath: null, ...overrides,
  };
}

describe('authorFamilies', () => {
  it('should name the base, and each committed graft donor and integrator', () => {
    expect(authorFamilies(synthesis([]), candidates)).toEqual(['anthropic']);
    expect(authorFamilies(synthesis([graft('codex', 'claude', 'f'.repeat(40))]), candidates)).toEqual(['anthropic', 'openai']);
    expect(authorFamilies(synthesis([graft('claude', 'gemini', 'f'.repeat(40))]), candidates)).toEqual(['anthropic', 'google']);
  });

  it('should leave out a graft that committed nothing, and name an unknown family by its provider', () => {
    expect(authorFamilies(synthesis([graft('codex', 'gemini', null)]), candidates)).toEqual(['anthropic']);
    expect(authorFamilies(synthesis([graft('opencode', 'claude', 'f'.repeat(40))]), candidates)).toEqual(['anthropic', 'opencode']);
  });
});

describe('pickVerifier', () => {
  const usable = [
    { provider: 'claude', family: 'anthropic' },
    { provider: 'codex', family: 'openai' },
    { provider: 'gemini', family: 'google' },
    { provider: 'opencode', family: null },
  ];

  it('should take the first usable CLI whose family wrote none of the commits', () => {
    expect(pickVerifier(['anthropic'], usable)).toEqual({ provider: 'codex', family: 'openai' });
    expect(pickVerifier(['anthropic', 'openai'], usable)).toEqual({ provider: 'gemini', family: 'google' });
  });

  it('should never fall back to an author family or an unknown one', () => {
    expect(pickVerifier(['anthropic', 'openai', 'google'], usable)).toBeNull();
    expect(pickVerifier(['anthropic'], [{ provider: 'claude', family: 'anthropic' }, { provider: 'opencode', family: null }])).toBeNull();
  });
});

describe('decideVerdict', () => {
  const pass = { status: 'PASS' as const, text: 'VERDICT: PASS' };

  it('should PASS when every gate and test passes and the review says PASS', () => {
    expect(decideVerdict({ headSha: HEAD, baseline: { test: 'pass' }, gates: { test: 'pass' }, tests: { 'openai-1': 'pass' }, review: pass }))
      .toMatchObject({ verdict: 'PASS', notes: [] });
  });

  it('should FAIL on a gate that passes on the base, a test that does not pass, or a FAIL review', () => {
    const failed = decideVerdict({ headSha: HEAD, baseline: { test: 'pass' }, gates: { test: 'fail' }, tests: { 'openai-1': 'error' }, review: pass });
    expect(failed.verdict).toBe('FAIL');
    expect(failed.reason).toBe(`gate test is fail at ${HEAD.slice(0, 12)}; adversarial test openai-1 is error at ${HEAD.slice(0, 12)}`);
    expect(decideVerdict({ headSha: HEAD, baseline: {}, gates: {}, tests: {}, review: { status: 'FAIL', text: 'VERDICT: FAIL' } }).reason).toBe('the review says FAIL');
  });

  it('should note a gate that fails on the base too, and review notes, as PASS+NOTES', () => {
    const noted = decideVerdict({ headSha: HEAD, baseline: { lint: 'fail' }, gates: { lint: 'fail' }, tests: {}, review: { status: 'NOTES', text: 'VERDICT: NOTES' } });
    expect(noted).toMatchObject({ verdict: 'PASS+NOTES', notes: [`gate lint is fail at ${HEAD.slice(0, 12)} and on the base`, 'the review has notes'] });
  });

  it('should be BLOCKED when the review gave no verdict and nothing failed', () => {
    expect(decideVerdict({ headSha: HEAD, baseline: {}, gates: { test: 'pass' }, tests: {}, review: null }))
      .toMatchObject({ verdict: 'BLOCKED', reason: 'the review gave no VERDICT line' });
  });
});

describe('parseReview', () => {
  it('should read the first VERDICT line, bold or not', () => {
    expect(parseReview('Looks fine.\n**VERDICT: notes**\n- rename x')?.status).toBe('NOTES');
    expect(parseReview('VERDICT: FAIL\nbroken')).toEqual({ status: 'FAIL', text: 'VERDICT: FAIL\nbroken' });
    expect(parseReview('I think it passes')).toBeNull();
  });
});

describe('verdictState', () => {
  it('should hold only for the verified head, locally and on the pushed branch', () => {
    expect(verdictState(verdict(), { local: HEAD, remote: null })).toEqual({ valid: true, reason: `for head ${HEAD.slice(0, 12)}` });
    expect(verdictState(verdict(), { local: HEAD, remote: HEAD }).valid).toBe(true);
    expect(verdictState(verdict(), { local: 'd'.repeat(40), remote: null }))
      .toEqual({ valid: false, reason: `void: concilium/r/integration is at dddddddddddd, the verdict is for ${HEAD.slice(0, 12)}; run verify-pr again` });
    expect(verdictState(verdict(), { local: HEAD, remote: 'e'.repeat(40) }).reason).toContain('void: the pushed branch is at eeeeeeeeeeee');
    expect(verdictState(verdict({ headSha: null }), { local: null, remote: null }).valid).toBe(false);
  });
});

describe('verification.md and the PR body', () => {
  it('should key the report to head, base and patch-id and name the verifier', () => {
    const md = verificationMarkdown(verdict(), { id: 'r', task: 'add a flag' });
    expect(md).toContain('## Verdict: PASS');
    expect(md).toContain(`- head: ${HEAD}`);
    expect(md).toContain(`- patch-id: ${'c'.repeat(40)}`);
    expect(md).toContain('- verifier: gemini (google)');
    expect(md).toContain('- author families: anthropic');
  });

  it('should hold the verdict, the dissent summary, the trail pointer and synthesis.md', () => {
    const open = { id: 'dissent-1', source: 'adversarial-test', summary: 'test fails', resolution: 'open', acceptanceClause: 'x' } as unknown as Dissent;
    const body = prBody({ runId: 'r', synthesisMd: '# Synthesis of run r\n', dissent: [open], verdict: verdict(), trail: { commitSha: 'f'.repeat(40), dir: '.concilium/runs/r' } });
    expect(body).toContain(`**Verdict: PASS** at \`${HEAD}\``);
    expect(body).toContain('1 records: 1 open (1 blocking), 0 warnings.\n- open dissent-1 (adversarial-test): test fails');
    expect(body).toContain(`\`.concilium/runs/r/decisions.tsv\`, \`dissent.json\` and \`synthesis.md\` in commit \`${'f'.repeat(40)}\``);
    expect(body.trimEnd().endsWith('# Synthesis of run r')).toBe(true);
  });

  it('should title the PR with the first line of the task, cut at 72 characters', () => {
    expect(prTitle('  add a flag\nmore detail')).toBe('add a flag');
    expect(prTitle('x'.repeat(100))).toHaveLength(72);
  });
});
