/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { getProviderInfo, PROVIDER_IDS, VENDOR_FAMILY } from '../agent/providers.js';
import type { RoleName, RoleSource } from './roles.js';

/** The per-repo factory config. Only its `roles:` section is read today. */
export const FACTORY_CONFIG = '.concilium/factory.yaml';

/** The agent CLIs of a known model family: the only ones the cross-family rules can vouch for. */
const KNOWN_FAMILY_CLIS = PROVIDER_IDS.filter((id) => getProviderInfo(id)?.family);

/**
 * Every rule the role config is checked against, its severity and the default fix. An error stops a command before
 * any agent CLI runs; a warning is printed and the command goes on. The cross-family rules (layer 3 C4) come last.
 */
export const ROLE_RULES = {
  'factory-yaml': { severity: 'error', hint: 'make it a YAML mapping, with the roles under `roles:`' },
  'roles-not-a-mapping': { severity: 'error', hint: 'write each role as `<role>: <cli[:model]>`, a list for implementer, adversary and juror' },
  'unknown-role': { severity: 'error', hint: 'use a role `concilium roles` lists' },
  'list-for-single-role': { severity: 'error', hint: 'give one cli[:model]; only implementer, adversary and juror take a list' },
  'no-members': { severity: 'error', hint: 'name at least one cli[:model], or drop the role for its default' },
  'keyword-with-members': { severity: 'error', hint: 'use the keyword alone, or list members without it' },
  'unknown-cli': { severity: 'error', hint: `use ${PROVIDER_IDS.join(', ')}, optionally with :model (jurors and the chairman may also be OpenRouter ids)` },
  'empty-model': { severity: 'error', hint: "name a model after the colon, or drop the colon for the CLI's own default" },
  'adversary-family-twice': { severity: 'error', hint: 'keep one adversary per model family' },
  'flag-syntax': { severity: 'error', hint: 'write --role <role>=<cli[:model]>' },
  'flag-repeated': { severity: 'error', hint: 'give a single-member role once' },
  'agents-and-implementer': { severity: 'error', hint: 'use --agents or --role implementer=..., not both' },
  'role-not-applicable': { severity: 'error', hint: 'set the role where it applies' },
  'judge-judges-itself': { severity: 'error', hint: 'pick a judge of a family with at most one implementer, or `auto`' },
  'judge-shares-family': { severity: 'warning', hint: 'pick a judge of a family no implementer has, or `auto`, to judge every tie cross-family' },
  'unknown-family': {
    severity: 'error',
    hint: `use ${KNOWN_FAMILY_CLIS.join(', ')}, or opencode:[<provider>/]<vendor>/<model> with a vendor of ${Object.keys(VENDOR_FAMILY).join(', ')} (a known model family), or \`auto\``,
  },
  'verifier-author-family': { severity: 'error', hint: 'pick a verifier of a family that wrote none of the code, or `auto`' },
} as const satisfies Record<string, { severity: 'error' | 'warning'; hint: string }>;

export type RoleRuleId = keyof typeof ROLE_RULES;
export type RoleRuleSeverity = (typeof ROLE_RULES)[RoleRuleId]['severity'];

/** One broken rule: which rule, the role it is about, where the offending value was set, and how to fix it. */
export type RoleViolation = {
  rule: RoleRuleId;
  severity: RoleRuleSeverity;
  role: RoleName | null;
  source: RoleSource;
  /** The config path: `--role judge`, `<repo>/.concilium/factory.yaml roles.judge`, `saved config roles.judge`. */
  at: string;
  message: string;
  hint: string;
};

/** Where a role setting came from: its source, and the config path of a role in it. */
export type RoleOrigin = { source: RoleSource; at: (role: RoleName | null) => string };

export const roleOrigin = {
  /** A command-line option: `--role judge`. */
  flag: (option = '--role'): RoleOrigin => ({ source: 'flag', at: (role) => (role ? `${option} ${role}` : option) }),
  /** A file or store holding a `roles:` mapping: `<file> roles.judge`. */
  file: (source: RoleSource, file: string): RoleOrigin => ({ source, at: (role) => (role ? `${file} roles.${role}` : file) }),
  /** Where a resolved role came from, for the rules checked after resolution. */
  resolved: (source: RoleSource): RoleOrigin => {
    if (source === 'flag') return roleOrigin.flag();
    if (source === 'repo') return roleOrigin.file('repo', FACTORY_CONFIG);
    if (source === 'saved') return roleOrigin.file('saved', 'saved config');
    return { source, at: (role) => (role ? `${source} ${role}` : source) };
  },
};

export function violation(rule: RoleRuleId, origin: RoleOrigin, role: RoleName | null, message: string, hint?: string): RoleViolation {
  return { rule, severity: ROLE_RULES[rule].severity, role, source: origin.source, at: origin.at(role), message, hint: hint ?? ROLE_RULES[rule].hint };
}

/** `[unknown-cli] --role judge: "nope" is not an agent CLI. Fix: use claude, ...` */
export function formatViolation(v: RoleViolation): string {
  return `[${v.rule}] ${v.at}: ${v.message}. Fix: ${v.hint}`;
}

/** Role config that breaks at least one rule; `violations` lists every one found. */
export class RolesValidationError extends Error {
  constructor(readonly violations: RoleViolation[]) {
    super(violations.map(formatViolation).join('\n'));
    this.name = 'RolesValidationError';
  }
}

/** Throws a `RolesValidationError` holding the errors among `violations`, if any; else returns the warnings. */
export function throwOnRoleErrors(violations: readonly RoleViolation[]): RoleViolation[] {
  const errors = violations.filter((v) => v.severity === 'error');
  if (errors.length > 0) throw new RolesValidationError(errors);
  return violations.filter((v) => v.severity === 'warning');
}
