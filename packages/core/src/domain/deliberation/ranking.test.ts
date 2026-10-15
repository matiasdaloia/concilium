/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { parseRankingFromText } from './ranking.js';

describe('parseRankingFromText', () => {
  it('should read the numbered list after FINAL RANKING and ignore earlier mentions', () => {
    const text = [
      'Response A is thorough. Response C misses edge cases.',
      '',
      'FINAL RANKING:',
      '1. Response B',
      '2. response a',
      '3. Response C',
    ].join('\n');

    expect(parseRankingFromText(text)).toEqual(['Response B', 'Response A', 'Response C']);
  });
});
