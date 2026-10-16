/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { configuredJudge, JudgeValidationError, judgePrompt, parseJudgeAnswer, pickJudge } from './judging.js';
import { freezeRubric } from './rubric.js';
import { PLAYBOOKS } from './playbooks.js';

describe('configuredJudge', () => {
  it('should keep the configured judge and flag it only when its family is one it reads or is unknown', () => {
    expect(configuredJudge('gemini:gemini-3-pro', ['anthropic', 'openai'])).toEqual({ provider: 'gemini:gemini-3-pro', sameFamily: false, sameFamilyReason: null });
    expect(configuredJudge('codex:gpt-5.2', ['anthropic', 'openai'])).toEqual({
      provider: 'codex:gpt-5.2', sameFamily: true, sameFamilyReason: 'the configured judge codex:gpt-5.2 is of one of the families it reads (anthropic, openai)',
    });
    expect(configuredJudge('opencode:openai/gpt-5.2', ['anthropic'])).toEqual({
      provider: 'opencode:openai/gpt-5.2', sameFamily: true, sameFamilyReason: 'the configured judge opencode:openai/gpt-5.2 is of an unknown family',
    });
  });
});

describe('pickJudge', () => {
  const usable = [
    { provider: 'claude', family: 'anthropic' },
    { provider: 'codex', family: 'openai' },
    { provider: 'opencode', family: null },
  ];

  it('should pick the first usable CLI of a family that wrote none of the tied candidates', () => {
    expect(pickJudge(['anthropic'], usable)).toEqual({ provider: 'codex', sameFamily: false, sameFamilyReason: null });
    expect(pickJudge(['openai', 'google'], usable)).toEqual({ provider: 'claude', sameFamily: false, sameFamilyReason: null });
  });

  it('should fall back to a same-family judge only when no other family is usable, flagged with the reason, never counting an unknown family as another one', () => {
    expect(pickJudge(['anthropic', 'openai'], usable)).toEqual({
      provider: 'claude', sameFamily: true, sameFamilyReason: 'no CLI outside the tied families (anthropic, openai) is usable, so claude judges',
    });
    expect(pickJudge(['anthropic', 'openai'], [...usable, { provider: 'gemini', family: 'google' }])).toMatchObject({ provider: 'gemini', sameFamily: false });
    expect(pickJudge(['anthropic'], [])).toBeNull();
  });
});

describe('judgePrompt', () => {
  it('should hold the task, the frozen rubric and each blind candidate, with no example ordering', () => {
    const rubric = freezeRubric(PLAYBOOKS.feature.rubric, { source: 'playbook' });
    const prompt = judgePrompt('add a flag', rubric, [
      { label: 'A', diff: '+a\n', evidence: ['ok, gate: test: pass'] },
      { label: 'B', diff: '+b\n', evidence: [] },
    ]);
    expect(prompt).toContain('Task:\nadd a flag');
    expect(prompt).toContain(rubric.sha256);
    for (const c of rubric.criteria) expect(prompt).toContain(c.description);
    expect(prompt).toContain('## Candidate A\nEvidence:\n- ok, gate: test: pass\nDiff against the base:\n```diff\n+a\n```');
    expect(prompt).toContain('## Candidate B\nEvidence:\n- none');
    expect(prompt).not.toMatch(/"candidate": "[AB]"/);
  });
});

describe('parseJudgeAnswer', () => {
  const full = (score = 7) => ['A', 'B'].flatMap((candidate) => ['works', 'fit'].map((criterion) => ({ candidate, criterion, score, reason: `${criterion} ok` })));

  it('should read one score per candidate and criterion, bare or fenced, and accept "Candidate A"', () => {
    expect(parseJudgeAnswer(JSON.stringify({ scores: full() }), ['A', 'B'], ['works', 'fit'])).toHaveLength(4);
    const fenced = '```json\n' + JSON.stringify({ scores: full().map((s) => ({ ...s, candidate: `Candidate ${s.candidate}` })) }) + '\n```';
    expect(parseJudgeAnswer(fenced, ['A', 'B'], ['works', 'fit'])[0]).toEqual({ label: 'A', criterion: 'works', score: 7, reason: 'works ok' });
  });

  it('should reject a missing, duplicate, unknown or out-of-range score and name every problem', () => {
    const scores = full();
    scores[0] = { ...scores[0], score: 11 };
    scores[1] = { ...scores[1], candidate: 'C' };
    scores[2] = { ...scores[3] };
    try {
      parseJudgeAnswer(JSON.stringify({ scores }), ['A', 'B'], ['works', 'fit']);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JudgeValidationError);
      expect((err as JudgeValidationError).problems).toEqual([
        'scores[0].score: must be a number from 0 to 10',
        'scores[1].candidate: must be one of A, B',
        'scores[3]: candidate B is scored on fit twice',
        'candidate A has no score for works',
        'candidate A has no score for fit',
        'candidate B has no score for works',
      ]);
    }
    expect(() => parseJudgeAnswer('they are both fine', ['A'], ['works'])).toThrow('answer: holds no JSON');
    expect(() => parseJudgeAnswer('{"criteria": []}', ['A'], ['works'])).toThrow('answer: has no "scores" list');
    expect(() => parseJudgeAnswer('{"scores": [{"candidate": "A", "criterion": "works", "score": 5, "reason": " "}]}', ['A'], ['works'])).toThrow('reason: must be a non-empty string');
  });
});
