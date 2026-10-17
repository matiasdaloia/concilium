/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import {
  defaultCodeRoles,
  parseFactoryRoles,
  parseRoleFlags,
  resolveCodeRoles,
  roleWarnings,
  RolesValidationError,
  validateRoles,
} from './roles.js';

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof RolesValidationError) return err.problems;
    throw err;
  }
  throw new Error('expected a RolesValidationError');
}

describe('validateRoles', () => {
  it('should accept every role with cli[:model] members, keywords, and OpenRouter ids for jurors and the chairman', () => {
    expect(validateRoles({
      planner: 'claude:claude-opus-5-5',
      implementer: ['claude:claude-opus-5-5', ' codex '],
      adversary: 'gemini',
      judge: 'codex:gpt-5.2',
      integrator: 'winner',
      juror: ['openai/gpt-5.2', 'claude'],
      chairman: 'google/gemini-3-pro',
    }, 'x')).toEqual({
      planner: 'claude:claude-opus-5-5',
      implementer: ['claude:claude-opus-5-5', 'codex'],
      adversary: ['gemini'],
      judge: 'codex:gpt-5.2',
      integrator: 'winner',
      juror: ['openai/gpt-5.2', 'claude'],
      chairman: 'google/gemini-3-pro',
    });
    expect(validateRoles({ adversary: 'same-as-implementer', judge: 'auto' }, 'x')).toEqual({ adversary: 'same-as-implementer', judge: 'auto' });
    expect(validateRoles({ verifier: 'auto' }, 'x')).toEqual({ verifier: 'auto' });
    expect(validateRoles({ verifier: 'gemini:gemini-3-pro' }, 'x')).toEqual({ verifier: 'gemini:gemini-3-pro' });
    expect(validateRoles(undefined, 'x')).toEqual({});
  });

  it('should name every problem at once', () => {
    const found = problems(() => validateRoles({
      planer: 'claude',
      planner: ['claude', 'codex'],
      judge: 'openai/gpt-5.2',
      integrator: 'codex:',
      implementer: [],
      adversary: ['claude', 'claude:claude-opus-5-5'],
      juror: ['claude', 3],
    }, 'roles'));
    expect(found).toEqual([
      'unknown role "planer" (use planner, implementer, adversary, judge, integrator, verifier, juror, chairman)',
      'planner: takes one member, not a list',
      'judge: "openai/gpt-5.2" is not an agent CLI (use claude, codex, gemini, opencode, optionally with :model)',
      'integrator: "codex:" has an empty model',
      'implementer: needs at least one member',
      'adversary: two members of the anthropic family (one adversary per family)',
      'juror: every member must be a non-empty string',
    ]);
  });

  it('should refuse a keyword listed with members, and a keyword of another role', () => {
    expect(problems(() => validateRoles({ adversary: ['same-as-implementer', 'codex'] }, 'x'))).toEqual(['adversary: "same-as-implementer" cannot be listed with other members']);
    expect(problems(() => validateRoles({ planner: 'winner' }, 'x'))).toEqual([expect.stringContaining('planner: "winner" is not an agent CLI')]);
    // The verifier is an agent CLI, never an OpenRouter id, and takes one member.
    expect(problems(() => validateRoles({ verifier: 'openai/gpt-5.2' }, 'x'))).toEqual([expect.stringContaining('verifier: "openai/gpt-5.2" is not an agent CLI')]);
    expect(problems(() => validateRoles({ verifier: ['codex', 'gemini'] }, 'x'))).toEqual(['verifier: takes one member, not a list']);
    expect(problems(() => validateRoles(['claude'], 'x'))).toEqual(['must map role names to members']);
  });
});

describe('parseFactoryRoles', () => {
  it('should read the roles section and ignore the others', () => {
    const text = [
      'checks:',
      '  detect: true',
      'roles:',
      '  planner: claude:claude-opus-5-5',
      '  implementer: [claude:claude-opus-5-5, codex]',
      '  judge: codex:gpt-5.2',
    ].join('\n');
    expect(parseFactoryRoles(text)).toEqual({ planner: 'claude:claude-opus-5-5', implementer: ['claude:claude-opus-5-5', 'codex'], judge: 'codex:gpt-5.2' });
    expect(parseFactoryRoles('checks: {}\n')).toEqual({});
    expect(parseFactoryRoles('')).toEqual({});
  });

  it('should name the file and the section in its errors', () => {
    expect(() => parseFactoryRoles('roles:\n  judge: [claude, codex]\n')).toThrow('.concilium/factory.yaml roles: judge: takes one member, not a list');
    expect(() => parseFactoryRoles('roles: claude\n')).toThrow('.concilium/factory.yaml roles: must map role names to members');
    expect(() => parseFactoryRoles('- roles\n')).toThrow('.concilium/factory.yaml: must be a mapping');
    expect(() => parseFactoryRoles('roles: [\n')).toThrow(/^\.concilium\/factory\.yaml: not valid YAML/);
  });
});

describe('parseRoleFlags', () => {
  it('should split list roles on commas and add repeated flags to the list', () => {
    expect(parseRoleFlags(['implementer=claude:claude-opus-5-5,codex', 'implementer=gemini', 'judge=codex:gpt-5.2', 'adversary=same-as-implementer'])).toEqual({
      implementer: ['claude:claude-opus-5-5', 'codex', 'gemini'], judge: 'codex:gpt-5.2', adversary: 'same-as-implementer',
    });
  });

  it('should refuse a flag without =, a single role given twice, and bad members', () => {
    expect(problems(() => parseRoleFlags(['claude', 'judge=codex', 'judge=gemini']))).toEqual(['"claude" must be <role>=<member>', 'judge: given more than once']);
    expect(problems(() => parseRoleFlags(['planner=nope']))).toEqual([expect.stringContaining('planner: "nope" is not an agent CLI')]);
    expect(problems(() => parseRoleFlags(['implementer=,']))).toEqual(['implementer: needs at least one member']);
  });
});

describe('resolveCodeRoles', () => {
  it('should take each role from the highest source that sets it, and default the rest', () => {
    const roles = resolveCodeRoles([
      ['flag', { judge: 'gemini' }],
      ['repo', { judge: 'codex', planner: 'codex:gpt-5.2' }],
      ['saved', { planner: 'claude', integrator: 'claude:claude-opus-5-5' }],
    ], () => ['claude', 'codex']);
    expect(roles).toEqual({
      planner: { value: 'codex:gpt-5.2', source: 'repo' },
      implementer: { value: ['claude', 'codex'], source: 'default' },
      adversary: { value: 'same-as-implementer', source: 'default' },
      judge: { value: 'gemini', source: 'flag' },
      integrator: { value: 'claude:claude-opus-5-5', source: 'saved' },
    });
  });

  it('should default the planner to the configured first implementer, and never detect when implementers are configured', () => {
    const roles = resolveCodeRoles([['saved', { implementer: ['codex:gpt-5.2', 'claude'] }]], () => { throw new Error('detected'); });
    expect(roles.planner).toEqual({ value: 'codex:gpt-5.2', source: 'default' });
    expect(roles.implementer).toEqual({ value: ['codex:gpt-5.2', 'claude'], source: 'saved' });
  });
});

describe('roleWarnings', () => {
  it('should warn when a configured judge is of an implementer family or of an unknown family', () => {
    const roles = defaultCodeRoles(['claude', 'codex']);
    expect(roleWarnings(roles)).toEqual([]);
    expect(roleWarnings({ ...roles, judge: { value: 'gemini', source: 'flag' } })).toEqual([]);
    expect(roleWarnings({ ...roles, judge: { value: 'codex:gpt-5.2', source: 'flag' } })).toEqual([
      'judge codex:gpt-5.2 is of an implementer family (openai), so ties among openai candidates are judged same-family and flagged',
    ]);
    expect(roleWarnings({ ...roles, judge: { value: 'opencode', source: 'repo' } })).toEqual([
      'judge opencode is of an unknown family, so every judgment and graft pick it makes is flagged same-family',
    ]);
  });
});
