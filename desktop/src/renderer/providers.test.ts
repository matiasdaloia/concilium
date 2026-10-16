/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_OPTIONS, emptyModelOptions } from './providers';

describe('desktop provider menu', () => {
  it('should list providers in the core registry order used by the CLI', () => {
    expect(PROVIDER_OPTIONS.map((p) => p.id)).toEqual(['claude', 'codex', 'gemini', 'opencode']);
    expect(Object.keys(emptyModelOptions())).toEqual(['claude', 'codex', 'gemini', 'opencode']);
  });

  it('should give every provider its own color', () => {
    expect(new Set(PROVIDER_OPTIONS.map((p) => p.color)).size).toBe(PROVIDER_OPTIONS.length);
  });
});
