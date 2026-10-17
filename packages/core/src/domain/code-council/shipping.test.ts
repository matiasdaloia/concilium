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
  draftReason,
  isTrailPath,
  parseReview,
  pickVerifier,
  prBody,
  prTitle,
  shipSource,
  verdictState,
  verificationMarkdown,
  type PrVerdict,
  type Verifier,
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

const GEMINI: Verifier = { provider: 'gemini', model: null, configured: false, sameFamily: false, family: 'google' };
const SAME_FAMILY: Verifier = {
  provider: 'claude', model: null, configured: false, sameFamily: true, family: 'anthropic',
  sameFamilyReason: 'no installed, signed-in CLI outside the author families (anthropic); claude (anthropic) verified',
};

function verdict(overrides: Partial<PrVerdict> = {}): PrVerdict {
  return {
    verdict: 'PASS', reason: 'all good', notes: [], verifier: GEMINI, authorFamilies: ['anthropic'],
    branch: 'concilium/r/integration', branchHead: HEAD, headSha: HEAD, trailSha: null, baseSha: 'b'.repeat(40), patchId: 'c'.repeat(40),
    gates: { test: 'pass' }, tests: {}, review: { status: 'PASS', text: 'VERDICT: PASS' }, verifiedAt: '2026-10-17T10:00:00.000Z', reportPath: null,
    ...overrides,
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

  it("should take an OpenCode author's family from its model id", () => {
    const routed = [...candidates, { candidateId: 'opencode-2', provider: 'opencode', model: 'openrouter/google/gemini-3-pro-preview' }];
    expect(authorFamilies(synthesis([graft('opencode-2', 'claude', 'f'.repeat(40))]), routed)).toEqual(['anthropic', 'google']);
    const only = { candidateId: 'opencode', provider: 'opencode', model: 'openai/gpt-5.2', branch: 'concilium/r/opencode', headSha: HEAD };
    expect(shipSource({ candidates: [only] })).toEqual({ kind: 'candidate', branch: 'concilium/r/opencode', authorFamilies: ['openai'] });
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
    expect(pickVerifier(['anthropic'], usable)).toEqual({ verifier: { provider: 'codex', model: null, configured: false, sameFamily: false, family: 'openai' }, notes: [] });
    expect(pickVerifier(['anthropic', 'openai'], usable, 'auto').verifier).toMatchObject({ provider: 'gemini', family: 'google', sameFamily: false });
  });

  it('should prefer a configured verifier outside the author families, with its model', () => {
    expect(pickVerifier(['anthropic'], usable, 'gemini:gemini-3-pro')).toEqual({
      verifier: { provider: 'gemini', model: 'gemini-3-pro', configured: true, sameFamily: false, family: 'google' }, notes: [],
    });
  });

  it('should pass over a configured verifier of an author family, or one not usable, and say why', () => {
    expect(pickVerifier(['anthropic', 'openai'], usable, 'codex:gpt-5.2')).toEqual({
      verifier: { provider: 'gemini', model: null, configured: false, sameFamily: false, family: 'google' },
      notes: ['the configured verifier codex:gpt-5.2 is of an author family (openai); gemini verifies instead'],
    });
    expect(pickVerifier(['anthropic'], usable.slice(0, 2), 'gemini').notes).toEqual(['the configured verifier gemini is not installed and signed in']);
  });

  it('should fall back to an author family, flagged same-family, only when no CLI outside them is usable', () => {
    expect(pickVerifier(['anthropic', 'openai', 'google'], usable).verifier).toEqual({
      provider: 'claude', model: null, configured: false, sameFamily: true, family: 'anthropic',
      sameFamilyReason: 'no installed, signed-in CLI outside the author families (anthropic, openai, google); claude (anthropic) verified',
    });
    // A configured verifier is the fallback when it is usable; an unknown family never counts as another family.
    expect(pickVerifier(['anthropic', 'openai', 'google'], usable, 'codex:gpt-5.2').verifier).toMatchObject({ provider: 'codex', model: 'gpt-5.2', configured: true, sameFamily: true });
    expect(pickVerifier(['anthropic'], [{ provider: 'opencode', family: null }]).verifier).toMatchObject({ provider: 'opencode', family: null, sameFamily: true });
  });

  // A configured verifier of an author family verifies only with the opt-in, and is then flagged everywhere.
  const OPT_IN = [
    { configured: 'claude', allow: false, provider: 'codex', configuredUsed: false, sameFamily: false, draft: null },
    {
      configured: 'claude', allow: true, provider: 'claude', configuredUsed: true, sameFamily: true,
      draft: 'the verifier is of an author family',
    },
    { configured: 'gemini', allow: true, provider: 'gemini', configuredUsed: true, sameFamily: false, draft: null },
    // Not usable, or of an unknown family: the opt-in does not apply.
    { configured: 'opencode:mistral/devstral-2', allow: true, provider: 'codex', configuredUsed: false, sameFamily: false, draft: null },
  ] as const;

  it.each(OPT_IN)('should verify with $provider for configured $configured and opt-in $allow', ({ configured, allow, provider, configuredUsed, sameFamily, draft }) => {
    const { verifier } = pickVerifier(['anthropic'], usable, configured, allow);
    expect(verifier).toMatchObject({ provider, configured: configuredUsed, sameFamily });
    const v = verdict({ verifier });
    expect(draftReason(v)).toBe(draft);
    const markdown = verificationMarkdown(v, { id: 'r', task: 'add a flag' });
    const body = prBody({ runId: 'r', synthesisMd: null, dissent: [], verdict: v, trailDir: '.concilium/runs/r' });
    if (!sameFamily) {
      expect(markdown).not.toContain('Warning');
      expect(body).not.toContain('Warning');
      return;
    }
    const warning = 'same-family verification: the configured verifier claude is of an author family (anthropic); allow-same-family-verifier allows it. The pull request is a draft.';
    expect(verifier).toMatchObject({ family: 'anthropic', sameFamilyReason: 'the configured verifier claude is of an author family (anthropic); allow-same-family-verifier allows it' });
    expect(markdown).toContain(`**Warning: ${warning}**`);
    expect(markdown).toContain('- verifier: claude (anthropic), SAME FAMILY as the authors');
    expect(body).toContain(`> **Warning: ${warning}**`);
  });

  it("should take a configured OpenCode verifier's family from its model id", () => {
    expect(pickVerifier(['anthropic'], usable, 'opencode:openrouter/google/gemini-3-pro-preview').verifier).toEqual({
      provider: 'opencode', model: 'openrouter/google/gemini-3-pro-preview', configured: true, sameFamily: false, family: 'google',
    });
    expect(pickVerifier(['anthropic'], usable, 'opencode:anthropic/claude-opus-4.6')).toMatchObject({ verifier: { provider: 'codex', configured: false } });
  });

  it('should find no verifier only when no CLI is usable', () => {
    expect(pickVerifier(['anthropic'], [])).toEqual({ verifier: null, notes: [] });
  });
});

describe('shipSource', () => {
  const candidate = (id: string, headSha: string | null) => ({ candidateId: id, provider: id, branch: `concilium/r/${id}`, headSha });

  it('should ship the integration branch, written by the base and the grafts', () => {
    expect(shipSource({ synthesis: synthesis([graft('codex', 'claude', 'f'.repeat(40))]), candidates: [candidate('claude', HEAD), candidate('codex', HEAD)] }))
      .toEqual({ kind: 'integration', branch: 'concilium/r/integration', authorFamilies: ['anthropic', 'openai'] });
  });

  it("should ship a single candidate's branch, written by its family alone", () => {
    const skipped = { ...synthesis([]), branch: null, base: null };
    expect(shipSource({ synthesis: skipped, candidates: [candidate('codex', HEAD)] })).toEqual({ kind: 'candidate', branch: 'concilium/r/codex', authorFamilies: ['openai'] });
    expect(shipSource({ candidates: [candidate('codex', null)] })).toEqual({ blocked: 'the only candidate, codex, has no head' });
  });

  it('should ship nothing from several candidates without an integration branch', () => {
    expect(shipSource({ candidates: [candidate('claude', HEAD), candidate('codex', HEAD)] })).toEqual({ blocked: 'the run has no integration branch' });
  });

  it('should treat only .concilium/runs/ paths as the trail', () => {
    expect(isTrailPath('.concilium/runs/r/decisions.tsv')).toBe(true);
    expect(isTrailPath('.concilium/verify.yaml')).toBe(false);
    expect(isTrailPath('src/.concilium/runs/x')).toBe(false);
  });
});

describe('draftReason', () => {
  it('should open a draft for a verdict that is not a pass or a same-family verifier, whatever the verdict', () => {
    expect(draftReason(verdict())).toBeNull();
    expect(draftReason(verdict({ verdict: 'PASS+NOTES' }))).toBeNull();
    expect(draftReason(verdict({ verdict: 'FAIL' }))).toBe('the verdict is FAIL');
    expect(draftReason(verdict({ verifier: SAME_FAMILY }))).toBe('the verifier is of an author family');
    expect(draftReason(verdict({ verdict: 'BLOCKED', verifier: SAME_FAMILY }))).toBe('the verdict is BLOCKED; the verifier is of an author family');
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
    expect(verdictState(verdict(), { local: HEAD, remote: null })).toEqual({ valid: true, reason: `for commit ${HEAD.slice(0, 12)}` });
    expect(verdictState(verdict(), { local: HEAD, remote: HEAD }).valid).toBe(true);
    expect(verdictState(verdict(), { local: 'd'.repeat(40), remote: null }))
      .toEqual({ valid: false, reason: `void: concilium/r/integration is at dddddddddddd, the verdict is for ${HEAD.slice(0, 12)}; run verify-pr again` });
    expect(verdictState(verdict(), { local: HEAD, remote: 'e'.repeat(40) }).reason).toContain('void: the pushed branch is at eeeeeeeeeeee');
    expect(verdictState(verdict({ headSha: null }), { local: null, remote: null }).valid).toBe(false);
  });

  it('should compare the local branch with the head it verified and the pushed branch with the commit it shipped', () => {
    const PARENT = 'p'.repeat(40);
    const withoutTrail = verdict({ branchHead: HEAD, headSha: PARENT, trailSha: HEAD });
    expect(verdictState(withoutTrail, { local: HEAD, remote: PARENT })).toEqual({ valid: true, reason: `for commit ${PARENT.slice(0, 12)}` });
    expect(verdictState(withoutTrail, { local: HEAD, remote: HEAD }).valid).toBe(false);
    expect(verdictState(withoutTrail, { local: PARENT, remote: null }).valid).toBe(false);
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
    expect(md).not.toContain('Warning');
  });

  it('should flag a same-family verifier and name the trail commit left out', () => {
    const md = verificationMarkdown(verdict({ verifier: SAME_FAMILY, trailSha: 'f'.repeat(40) }), { id: 'r', task: 'add a flag' });
    expect(md).toContain(`**Warning: same-family verification: ${SAME_FAMILY.sameFamily && SAME_FAMILY.sameFamilyReason}. The pull request is a draft.**`);
    expect(md).toContain('- verifier: claude (anthropic), SAME FAMILY as the authors');
    expect(md).toContain(`- trail commit left out: ${'f'.repeat(40)}`);
  });

  it('should hold the verdict, the dissent summary, the trail pointer and synthesis.md', () => {
    const open = { id: 'dissent-1', source: 'adversarial-test', summary: 'test fails', resolution: 'open', acceptanceClause: 'x' } as unknown as Dissent;
    const body = prBody({ runId: 'r', synthesisMd: '# Synthesis of run r\n', dissent: [open], verdict: verdict({ trailSha: 'f'.repeat(40) }), trailDir: '.concilium/runs/r' });
    expect(body).toContain(`**Verdict: PASS** at \`${HEAD}\``);
    expect(body).toContain('1 records: 1 open (1 blocking), 0 warnings.\n- open dissent-1 (adversarial-test): test fails');
    expect(body).toContain(
      `\`.concilium/runs/r/decisions.tsv\`, \`dissent.json\` and \`synthesis.md\` are in commit \`${'f'.repeat(40)}\` on \`concilium/r/integration\`, left out of this pull request`,
    );
    expect(body).not.toContain('Warning');
    expect(body.trimEnd().endsWith('# Synthesis of run r')).toBe(true);
  });

  it('should warn in the PR body when the verifier is of an author family', () => {
    const body = prBody({ runId: 'r', synthesisMd: null, dissent: [], verdict: verdict({ verifier: SAME_FAMILY }), trailDir: '.concilium/runs/r' });
    expect(body).toContain('by claude (anthropic), SAME FAMILY as the authors');
    expect(body).toContain('> **Warning: same-family verification: no installed, signed-in CLI outside the author families (anthropic); claude (anthropic) verified. The pull request is a draft.**');
  });

  it('should title the PR with the first line of the task, cut at 72 characters', () => {
    expect(prTitle('  add a flag\nmore detail')).toBe('add a flag');
    expect(prTitle('x'.repeat(100))).toHaveLength(72);
  });
});
