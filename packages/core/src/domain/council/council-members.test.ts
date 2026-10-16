/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { memberFamily, parseCouncilMember, resolveCouncil } from './council-members.js';

describe('parseCouncilMember', () => {
  it('should read cli[:model] specs as agent CLI members', () => {
    expect(parseCouncilMember('claude')).toEqual({ kind: 'cli', cli: 'claude' });
    expect(parseCouncilMember(' codex:gpt-5.2 ')).toEqual({ kind: 'cli', cli: 'codex', model: 'gpt-5.2' });
    expect(parseCouncilMember('opencode:openai/gpt-5.2')).toEqual({ kind: 'cli', cli: 'opencode', model: 'openai/gpt-5.2' });
    expect(parseCouncilMember('gemini:')).toEqual({ kind: 'cli', cli: 'gemini' });
  });

  it('should read anything else as an OpenRouter model id', () => {
    expect(parseCouncilMember('openai/gpt-5.2')).toEqual({ kind: 'openrouter', model: 'openai/gpt-5.2' });
    expect(parseCouncilMember('anthropic/claude-opus-4.6')).toEqual({ kind: 'openrouter', model: 'anthropic/claude-opus-4.6' });
  });

  it('should know the model family of CLIs, OpenCode models and OpenRouter ids', () => {
    expect(memberFamily(parseCouncilMember('claude:opus'))).toBe('anthropic');
    expect(memberFamily(parseCouncilMember('gemini'))).toBe('google');
    expect(memberFamily(parseCouncilMember('opencode'))).toBeNull();
    expect(memberFamily(parseCouncilMember('opencode:openai/gpt-5.2'))).toBe('openai');
    expect(memberFamily(parseCouncilMember('google/gemini-3-pro-preview'))).toBe('google');
  });
});

describe('resolveCouncil', () => {
  const auto = { councilModels: [], chairmanModel: '', hasOpenRouterKey: false };

  it('should seat every usable CLI as a juror and a Gemini chairman when all families have one seat', () => {
    expect(resolveCouncil({ ...auto, usableClis: ['claude', 'codex', 'gemini', 'opencode'] })).toEqual({
      councilModels: ['claude', 'codex', 'gemini'],
      chairmanModel: 'gemini',
      notes: [],
    });
  });

  it('should pick the chairman from the family with the fewest juror seats', () => {
    const council = resolveCouncil({ ...auto, councilModels: ['gemini', 'gemini:gemini-2.5-flash', 'claude'], usableClis: ['claude', 'codex', 'gemini'] });

    expect(council.councilModels).toEqual(['gemini', 'gemini:gemini-2.5-flash', 'claude']);
    expect(council.chairmanModel).toBe('codex');
  });

  it('should pick a chairman from another family than most jurors when one is installed', () => {
    expect(resolveCouncil({ ...auto, councilModels: ['claude', 'claude:sonnet'], usableClis: ['claude', 'gemini'] }).chairmanModel).toBe('gemini');
  });

  it('should fall back to OpenCode only when no CLI with a known family is usable', () => {
    expect(resolveCouncil({ ...auto, usableClis: ['opencode'] })).toEqual({ councilModels: ['opencode'], chairmanModel: 'opencode', notes: [] });
  });

  it('should keep configured members as they are', () => {
    const council = resolveCouncil({ councilModels: ['codex:gpt-5.2', 'openai/gpt-5.2'], chairmanModel: 'claude', usableClis: [], hasOpenRouterKey: true });

    expect(council).toEqual({ councilModels: ['codex:gpt-5.2', 'openai/gpt-5.2'], chairmanModel: 'claude', notes: [] });
  });

  it('should skip OpenRouter members without an API key and fill in from the installed CLIs', () => {
    const council = resolveCouncil({
      councilModels: ['openai/gpt-5.2', 'google/gemini-3-pro-preview'],
      chairmanModel: 'google/gemini-3-pro-preview',
      usableClis: ['claude', 'codex'],
      hasOpenRouterKey: false,
    });

    expect(council.councilModels).toEqual(['claude', 'codex']);
    expect(council.chairmanModel).toBe('codex');
    expect(council.notes).toEqual([
      'OpenRouter juror openai/gpt-5.2 skipped: no OpenRouter API key is configured.',
      'OpenRouter juror google/gemini-3-pro-preview skipped: no OpenRouter API key is configured.',
      'OpenRouter chairman google/gemini-3-pro-preview skipped: no OpenRouter API key is configured.',
    ]);
  });

  it('should leave the council empty and say so when nothing is usable', () => {
    const council = resolveCouncil({ ...auto, usableClis: [] });

    expect(council.councilModels).toEqual([]);
    expect(council.chairmanModel).toBe('');
    expect(council.notes[0]).toMatch(/^No juror is available/);
  });
});
