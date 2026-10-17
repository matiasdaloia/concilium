/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { formatViolation, ROLE_RULES, roleOrigin, RolesValidationError, throwOnRoleErrors, type RoleRuleId, type RoleViolation } from './role-rules.js';
import {
  checkRoleFamilies,
  defaultCodeRoles,
  parseCommandRoles,
  parseFactoryRoles,
  parseRoleFlags,
  resolveCodeRoles,
  validateRoles,
  type CodeRoleMap,
} from './roles.js';

const FILE = roleOrigin.file('repo', '/r/.concilium/factory.yaml');

function violations(fn: () => unknown): RoleViolation[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof RolesValidationError) return err.violations;
    throw err;
  }
  throw new Error('expected a RolesValidationError');
}

const rules = (found: RoleViolation[]) => found.map((v) => [v.rule, v.at]);

/** Implementers claude and codex, with the given roles on top. */
function roles(overrides: Partial<CodeRoleMap>): CodeRoleMap {
  return { ...defaultCodeRoles(['claude', 'codex']), ...overrides };
}

describe('role rules', () => {
  // One config per rule that breaks only that rule, with where it was set.
  const CASES: { rule: RoleRuleId; source: string; at: string; found: () => RoleViolation[] }[] = [
    { rule: 'factory-yaml', source: 'repo', at: '/r/.concilium/factory.yaml', found: () => violations(() => parseFactoryRoles('roles: [\n', '/r/.concilium/factory.yaml')) },
    { rule: 'roles-not-a-mapping', source: 'repo', at: '/r/.concilium/factory.yaml', found: () => violations(() => parseFactoryRoles('roles: claude\n', '/r/.concilium/factory.yaml')) },
    { rule: 'unknown-role', source: 'repo', at: '/r/.concilium/factory.yaml roles.planer', found: () => violations(() => validateRoles({ planer: 'claude' }, FILE)) },
    { rule: 'list-for-single-role', source: 'repo', at: '/r/.concilium/factory.yaml roles.judge', found: () => violations(() => validateRoles({ judge: ['claude', 'codex'] }, FILE)) },
    { rule: 'no-members', source: 'flag', at: '--role implementer', found: () => violations(() => parseRoleFlags(['implementer=,'])) },
    { rule: 'keyword-with-members', source: 'repo', at: '/r/.concilium/factory.yaml roles.adversary', found: () => violations(() => validateRoles({ adversary: ['same-as-implementer', 'codex'] }, FILE)) },
    { rule: 'unknown-cli', source: 'flag', at: '--role judge', found: () => violations(() => parseRoleFlags(['judge=nope'])) },
    { rule: 'empty-model', source: 'repo', at: '/r/.concilium/factory.yaml roles.integrator', found: () => violations(() => validateRoles({ integrator: 'codex:' }, FILE)) },
    { rule: 'adversary-family-twice', source: 'saved', at: 'saved config roles.adversary', found: () => violations(() => validateRoles({ adversary: ['claude', 'claude:claude-opus-5-5'] }, roleOrigin.file('saved', 'saved config'))) },
    { rule: 'flag-syntax', source: 'flag', at: '--role', found: () => violations(() => parseRoleFlags(['claude'])) },
    { rule: 'flag-repeated', source: 'flag', at: '--role judge', found: () => violations(() => parseRoleFlags(['judge=codex', 'judge=gemini'])) },
    { rule: 'agents-and-implementer', source: 'flag', at: '--role implementer', found: () => violations(() => parseCommandRoles('code', { agents: 'claude', roles: ['implementer=codex'] })) },
    { rule: 'role-not-applicable', source: 'flag', at: '--role verifier', found: () => violations(() => parseCommandRoles('code', { roles: ['verifier=gemini'] })) },
    { rule: 'judge-judges-itself', source: 'repo', at: '.concilium/factory.yaml roles.judge', found: () => checkRoleFamilies({ roles: { ...defaultCodeRoles(['claude', 'claude:claude-opus-5-5', 'codex']), judge: { value: 'claude', source: 'repo' } } }) },
    { rule: 'judge-shares-family', source: 'flag', at: '--role judge', found: () => checkRoleFamilies({ roles: roles({ judge: { value: 'codex:gpt-5.2', source: 'flag' } }) }) },
    { rule: 'unknown-family', source: 'saved', at: 'saved config roles.judge', found: () => checkRoleFamilies({ roles: roles({ judge: { value: 'opencode', source: 'saved' } }) }) },
    { rule: 'verifier-author-family', source: 'flag', at: '--role verifier', found: () => checkRoleFamilies({ verifier: { value: 'claude', source: 'flag' }, authors: ['anthropic'] }) },
  ];

  it('should have a case for every rule', () => {
    expect(CASES.map((c) => c.rule).sort()).toEqual(Object.keys(ROLE_RULES).sort());
  });

  it.each(CASES)('should flag $rule with its severity, source, config path and fix', ({ rule, source, at, found }) => {
    const [v, ...rest] = found();
    expect(rest).toEqual([]);
    expect(v).toMatchObject({ rule, severity: ROLE_RULES[rule].severity, source, at });
    expect(v.message).not.toBe('');
    expect(formatViolation(v)).toBe(`[${rule}] ${at}: ${v.message}. Fix: ${v.hint}`);
    // An error stops the command; a warning is returned to print.
    if (v.severity === 'error') expect(() => throwOnRoleErrors([v])).toThrow(RolesValidationError);
    else expect(throwOnRoleErrors([v])).toEqual([v]);
  });
});

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
    }, FILE)).toEqual({
      planner: 'claude:claude-opus-5-5',
      implementer: ['claude:claude-opus-5-5', 'codex'],
      adversary: ['gemini'],
      judge: 'codex:gpt-5.2',
      integrator: 'winner',
      juror: ['openai/gpt-5.2', 'claude'],
      chairman: 'google/gemini-3-pro',
    });
    expect(validateRoles({ adversary: 'same-as-implementer', judge: 'auto' }, FILE)).toEqual({ adversary: 'same-as-implementer', judge: 'auto' });
    expect(validateRoles({ verifier: 'auto' }, FILE)).toEqual({ verifier: 'auto' });
    expect(validateRoles({ verifier: 'gemini:gemini-3-pro' }, FILE)).toEqual({ verifier: 'gemini:gemini-3-pro' });
    expect(validateRoles(undefined, FILE)).toEqual({});
  });

  it('should name every violation at once', () => {
    const found = violations(() => validateRoles({
      planer: 'claude',
      planner: ['claude', 'codex'],
      judge: 'openai/gpt-5.2',
      integrator: 'codex:',
      implementer: [],
      adversary: ['claude', 'claude:claude-opus-5-5'],
      juror: ['claude', 3],
    }, FILE));
    expect(rules(found)).toEqual([
      ['unknown-role', '/r/.concilium/factory.yaml roles.planer'],
      ['list-for-single-role', '/r/.concilium/factory.yaml roles.planner'],
      ['unknown-cli', '/r/.concilium/factory.yaml roles.judge'],
      ['empty-model', '/r/.concilium/factory.yaml roles.integrator'],
      ['no-members', '/r/.concilium/factory.yaml roles.implementer'],
      ['adversary-family-twice', '/r/.concilium/factory.yaml roles.adversary'],
      ['unknown-cli', '/r/.concilium/factory.yaml roles.juror'],
    ]);
    expect(found[0].hint).toBe('use planner, implementer, adversary, judge, integrator, verifier, juror, chairman');
    expect(found[2].message).toBe('"openai/gpt-5.2" is not an agent CLI');
  });

  it('should refuse a keyword of another role, and a verifier that is not one agent CLI', () => {
    expect(rules(violations(() => validateRoles({ planner: 'winner' }, FILE)))).toEqual([['unknown-cli', '/r/.concilium/factory.yaml roles.planner']]);
    expect(rules(violations(() => validateRoles({ verifier: 'openai/gpt-5.2' }, FILE)))).toEqual([['unknown-cli', '/r/.concilium/factory.yaml roles.verifier']]);
    expect(rules(violations(() => validateRoles({ verifier: ['codex', 'gemini'] }, FILE)))).toEqual([['list-for-single-role', '/r/.concilium/factory.yaml roles.verifier']]);
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

  it('should name the file and the key in its errors', () => {
    expect(() => parseFactoryRoles('roles:\n  judge: [claude, codex]\n')).toThrow('[list-for-single-role] .concilium/factory.yaml roles.judge: takes one member, not a list. Fix: ');
    expect(() => parseFactoryRoles('- roles\n')).toThrow('[factory-yaml] .concilium/factory.yaml: must be a mapping');
    expect(() => parseFactoryRoles('roles: [\n')).toThrow(/^\[factory-yaml\] \.concilium\/factory\.yaml: not valid YAML/);
  });
});

describe('parseRoleFlags', () => {
  it('should split list roles on commas and add repeated flags to the list', () => {
    expect(parseRoleFlags(['implementer=claude:claude-opus-5-5,codex', 'implementer=gemini', 'judge=codex:gpt-5.2', 'adversary=same-as-implementer'])).toEqual({
      implementer: ['claude:claude-opus-5-5', 'codex', 'gemini'], judge: 'codex:gpt-5.2', adversary: 'same-as-implementer',
    });
  });

  it('should name every malformed flag at once', () => {
    expect(rules(violations(() => parseRoleFlags(['claude', 'judge=codex', 'judge=gemini'])))).toEqual([['flag-syntax', '--role'], ['flag-repeated', '--role judge']]);
  });
});

describe('parseCommandRoles', () => {
  it('should apply only the roles of each command', () => {
    expect(parseCommandRoles('code', { agents: 'claude,codex', roles: ['judge=gemini'] })).toEqual({ judge: 'gemini', implementer: ['claude', 'codex'] });
    expect(parseCommandRoles('factory', { roles: ['verifier=gemini', 'planner=claude'] })).toEqual({ verifier: 'gemini', planner: 'claude' });
    expect(parseCommandRoles('verify-pr', { roles: ['verifier=gemini'] })).toEqual({ verifier: 'gemini' });
    expect(parseCommandRoles('roles', { roles: ['juror=claude', 'verifier=gemini'] })).toEqual({ juror: ['claude'], verifier: 'gemini' });

    const code = violations(() => parseCommandRoles('code', { roles: ['juror=claude', 'chairman=codex', 'verifier=gemini'] }));
    expect(rules(code)).toEqual([['role-not-applicable', '--role juror'], ['role-not-applicable', '--role chairman'], ['role-not-applicable', '--role verifier']]);
    expect(code[0].hint).toContain('concilium run --juror-models');
    expect(code[2].hint).toContain('concilium pr --role verifier=');
    const pr = violations(() => parseCommandRoles('pr', { roles: ['judge=codex'] }));
    expect(pr).toEqual([expect.objectContaining({ rule: 'role-not-applicable', message: 'judge does not apply to concilium pr' })]);
  });

  it('should name --agents in its own violations, and collect every violation of the flags', () => {
    expect(rules(violations(() => parseCommandRoles('code', { agents: 'nope', roles: ['judge=nope', 'verifier=gemini'] })))).toEqual([
      ['unknown-cli', '--role judge'], ['unknown-cli', '--agents'], ['role-not-applicable', '--role verifier'],
    ]);
  });
});

describe('checkRoleFamilies', () => {
  it('should pass auto, and a judge or verifier of a family no implementer has', () => {
    expect(checkRoleFamilies({ roles: roles({}), verifier: { value: 'auto', source: 'default' } })).toEqual([]);
    expect(checkRoleFamilies({ roles: roles({ judge: { value: 'gemini', source: 'flag' } }), verifier: { value: 'gemini:gemini-3-pro', source: 'repo' } })).toEqual([]);
  });

  it('should count implementers per family to tell a judge that can judge only itself from one that shares a family', () => {
    const twoClaudes = defaultCodeRoles(['claude', 'claude:claude-opus-5-5']);
    expect(rules(checkRoleFamilies({ roles: { ...twoClaudes, judge: { value: 'claude', source: 'flag' } } }))).toEqual([['judge-judges-itself', '--role judge']]);
    expect(rules(checkRoleFamilies({ roles: roles({ judge: { value: 'claude', source: 'flag' } }) }))).toEqual([['judge-shares-family', '--role judge']]);
  });

  it('should hold the verifier to the implementer and integrator families before the code exists, and to its authors after', () => {
    const verifier = { value: 'gemini', source: 'saved' } as const;
    expect(rules(checkRoleFamilies({ roles: roles({ integrator: { value: 'gemini', source: 'repo' } }), verifier }))).toEqual([['verifier-author-family', 'saved config roles.verifier']]);
    expect(checkRoleFamilies({ roles: roles({}), verifier })).toEqual([]);
    expect(checkRoleFamilies({ verifier: { value: 'claude', source: 'flag' }, authors: ['openai'] })).toEqual([]);
    expect(rules(checkRoleFamilies({ verifier: { value: 'opencode', source: 'flag' }, authors: ['openai'] }))).toEqual([['unknown-family', '--role verifier']]);
  });

  it("should take an OpenCode member's family from its model id, and keep an unknown vendor unknown", () => {
    const verifier = (value: string) => checkRoleFamilies({ verifier: { value, source: 'flag' }, authors: ['openai'] });
    expect(verifier('opencode:google/gemini-2.5-pro')).toEqual([]);
    expect(verifier('opencode:openrouter/anthropic/claude-opus-4.6')).toEqual([]);
    expect(rules(verifier('opencode:openrouter/openai/gpt-5.2'))).toEqual([['verifier-author-family', '--role verifier']]);
    expect(rules(verifier('opencode:mistral/devstral-2'))).toEqual([['unknown-family', '--role verifier']]);
    // An OpenCode implementer on an OpenAI model is an openai seat: two of them leave codex judging itself.
    const openai = defaultCodeRoles(['codex', 'opencode:openai/gpt-5.2', 'claude']);
    expect(rules(checkRoleFamilies({ roles: { ...openai, judge: { value: 'codex', source: 'flag' } } }))).toEqual([['judge-judges-itself', '--role judge']]);
    expect(rules(checkRoleFamilies({ roles: roles({ judge: { value: 'opencode:google/gemini-2.5-pro', source: 'flag' } }) }))).toEqual([]);
  });

  it('should count an OpenCode adversary toward the family of its model', () => {
    expect(rules(violations(() => validateRoles({ adversary: ['gemini', 'opencode:openrouter/google/gemini-3-pro-preview'] }, FILE))))
      .toEqual([['adversary-family-twice', '/r/.concilium/factory.yaml roles.adversary']]);
    expect(validateRoles({ adversary: ['gemini', 'opencode:mistral/devstral-2'] }, FILE)).toEqual({ adversary: ['gemini', 'opencode:mistral/devstral-2'] });
  });
});

describe('resolveCodeRoles', () => {
  it('should take each role from the highest source that sets it, and default the rest', () => {
    const resolved = resolveCodeRoles([
      ['flag', { judge: 'gemini' }],
      ['repo', { judge: 'codex', planner: 'codex:gpt-5.2' }],
      ['saved', { planner: 'claude', integrator: 'claude:claude-opus-5-5' }],
    ], () => ['claude', 'codex']);
    expect(resolved).toEqual({
      planner: { value: 'codex:gpt-5.2', source: 'repo' },
      implementer: { value: ['claude', 'codex'], source: 'default' },
      adversary: { value: 'same-as-implementer', source: 'default' },
      judge: { value: 'gemini', source: 'flag' },
      integrator: { value: 'claude:claude-opus-5-5', source: 'saved' },
    });
  });

  it('should default the planner to the configured first implementer, and never detect when implementers are configured', () => {
    const resolved = resolveCodeRoles([['saved', { implementer: ['codex:gpt-5.2', 'claude'] }]], () => { throw new Error('detected'); });
    expect(resolved.planner).toEqual({ value: 'codex:gpt-5.2', source: 'default' });
    expect(resolved.implementer).toEqual({ value: ['codex:gpt-5.2', 'claude'], source: 'saved' });
  });
});
