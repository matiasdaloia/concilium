/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { buildRankingPrompt, buildSynthesisPrompt, wrapPromptForResearch } from './prompts.js';
import { parseRankingFromText } from './ranking.js';

const RESULTS = [
  { model: 'claude', response: 'Plan one' },
  { model: 'codex', response: 'Plan two' },
  { model: 'opencode', response: 'Plan three' },
];

describe('buildRankingPrompt', () => {
  it('should not show jurors a concrete example ranking of the response labels', () => {
    const [prompt] = buildRankingPrompt('task', RESULTS);
    const instructions = prompt.slice(prompt.lastIndexOf('Plan three') + 'Plan three'.length);

    expect(instructions).toContain('FINAL RANKING:');
    expect(instructions).not.toMatch(/Response [A-Z]\b/);
  });

  it('should keep the requested format readable by the ranking parser', () => {
    const answer = 'Reviews...\n\nFINAL RANKING:\n1. Response B\n2. Response C\n3. Response A';

    expect(parseRankingFromText(answer)).toEqual(['Response B', 'Response C', 'Response A']);
  });

  it('should map every response label to its model', () => {
    const [, labelToModel] = buildRankingPrompt('task', RESULTS);

    expect(labelToModel).toEqual({ 'Response A': 'claude', 'Response B': 'codex', 'Response C': 'opencode' });
  });

  it('should show each response under its label and the task being reviewed', () => {
    const [prompt] = buildRankingPrompt('Add rate limiting', RESULTS);

    expect(prompt).toContain('Task being addressed: Add rate limiting');
    expect(prompt).toContain('Response A:\nPlan one');
    expect(prompt).toContain('Response B:\nPlan two');
    expect(prompt).toContain('Response C:\nPlan three');
  });

  it('should not reveal which model wrote which response', () => {
    const results = [
      { model: 'claude · opus', response: 'Plan one' },
      { model: 'codex · gpt-5.2-codex', response: 'Plan two' },
    ];
    const [prompt] = buildRankingPrompt('task', results);

    expect(prompt).not.toContain('claude · opus');
    expect(prompt).not.toContain('codex · gpt-5.2-codex');
  });
});

describe('buildSynthesisPrompt', () => {
  const RANKINGS = [
    { model: 'juror/one', ranking: 'B is best', parsedRanking: ['Response B', 'Response A'] },
    { model: 'juror/two', ranking: 'A is best', parsedRanking: ['Response A', 'Response B'] },
  ];
  const TWO = [
    { model: 'claude · opus', response: 'Plan one' },
    { model: 'codex · gpt-5.2-codex', response: 'Plan two' },
  ];

  it('should give the chairman the task, every labelled plan and every juror evaluation', () => {
    const prompt = buildSynthesisPrompt('Add rate limiting', TWO, RANKINGS);

    expect(prompt).toContain('Original task: Add rate limiting');
    expect(prompt).toContain('Response A:\nPlan one');
    expect(prompt).toContain('Response B:\nPlan two');
    expect(prompt).toContain('Juror 1 Evaluation:\nB is best');
    expect(prompt).toContain('Juror 2 Evaluation:\nA is best');
  });

  it('should not reveal agent or juror model names to the chairman', () => {
    const prompt = buildSynthesisPrompt('task', TWO, RANKINGS);

    for (const name of ['claude · opus', 'codex · gpt-5.2-codex', 'juror/one', 'juror/two']) {
      expect(prompt).not.toContain(name);
    }
  });
});

describe('wrapPromptForResearch', () => {
  it('should end with the user request after the read-only planning rules', () => {
    const wrapped = wrapPromptForResearch('Fix the login bug');

    expect(wrapped.endsWith('## USER REQUEST\n\nFix the login bug')).toBe(true);
    expect(wrapped).toContain('NEVER write, edit, create, or delete any files');
    expect(wrapped).toContain('NEVER ask the user questions');
  });
});
