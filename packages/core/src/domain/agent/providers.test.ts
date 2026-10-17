/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { agentFamily, familyKey } from './providers.js';

describe('agentFamily', () => {
  it.each([
    ['claude', undefined, 'anthropic'],
    ['codex', 'gpt-5.2', 'openai'],
    ['gemini', 'gemini-3-pro-preview', 'google'],
    // A CLI with a family keeps it whatever the model id says.
    ['claude', 'openai/gpt-5.2', 'anthropic'],
    // OpenCode: <vendor>/<model>.
    ['opencode', 'google/gemini-2.5-pro', 'google'],
    ['opencode', 'anthropic/claude-sonnet-4-5', 'anthropic'],
    ['opencode', 'openai/gpt-5.2', 'openai'],
    // OpenCode through a router: <provider>/<vendor>/<model>.
    ['opencode', 'openrouter/google/gemini-3-pro-preview', 'google'],
    ['opencode', 'openrouter/anthropic/claude-opus-4.6', 'anthropic'],
    ['opencode', 'openrouter/openai/gpt-5.2', 'openai'],
    // Unknown vendors, routers without a known vendor, and no model stay unknown.
    ['opencode', undefined, null],
    ['opencode', null, null],
    ['opencode', 'gpt-5.2', null],
    ['opencode', 'mistral/devstral-2', null],
    ['opencode', 'openrouter/mistralai/devstral-2', null],
    ['opencode', 'github-copilot/claude-sonnet-4', null],
    ['opencode', 'openrouter/gpt-5.2', null],
  ] as const)('should give %s with model %s the family %s', (provider, model, family) => {
    expect(agentFamily(provider, model)).toBe(family);
  });

  it('should count an unknown family toward the provider id', () => {
    expect(familyKey('opencode', 'openrouter/google/gemini-3-pro-preview')).toBe('google');
    expect(familyKey('opencode', 'mistral/devstral-2')).toBe('opencode');
    expect(familyKey('codex')).toBe('openai');
  });
});
