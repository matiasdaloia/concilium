/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { buildRankingPrompt } from './prompts.js';
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
});
