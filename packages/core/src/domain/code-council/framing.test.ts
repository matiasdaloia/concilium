/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { missingPlaybookSteps } from './framing.js';

describe('missingPlaybookSteps', () => {
  it('should accept each step listed by number as done or skipped, in the usual list styles', () => {
    const text = [
      'Summary of the work.',
      '1. Reproduce: done, sum.test.js fails on the base',
      '- 2: done',
      '**Step 3** skipped: nothing to bisect',
      '4) Done.',
    ].join('\n');
    expect(missingPlaybookSteps(text, 4)).toEqual([]);
  });

  it('should report steps with no line, or a line that says neither done nor skipped', () => {
    expect(missingPlaybookSteps('1. done\n3. working on it\n12. done', 3)).toEqual([2, 3]);
    expect(missingPlaybookSteps('claude done', 2)).toEqual([1, 2]);
  });
});
