/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { parse as parseYaml } from 'yaml';
import { getProviderInfo, isProviderId, PROVIDER_IDS } from '../agent/providers.js';
import { parseCouncilMember } from '../council/council-members.js';

/** The per-repo factory config. Only its `roles:` section is read today. */
export const FACTORY_CONFIG = '.concilium/factory.yaml';

/** The code-council roles. Each is played by agent CLIs given as `cli[:model]`. */
export const CODE_ROLES = ['planner', 'implementer', 'adversary', 'judge', 'integrator'] as const;
export type CodeRoleName = (typeof CODE_ROLES)[number];

/** Every role: the code council's, then the plan council's jurors and chairman (which may also be OpenRouter ids). */
export const ROLE_NAMES = [...CODE_ROLES, 'juror', 'chairman'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Roles played by a list of members; the others take one. */
const LIST_ROLES: readonly RoleName[] = ['implementer', 'adversary', 'juror'];

/** Per role, the word that names its built-in behavior instead of a member. */
export const ROLE_KEYWORDS = { adversary: 'same-as-implementer', judge: 'auto', integrator: 'winner' } as const;

export type RoleValue = string | string[];
/** Configured roles from one source. A list role holds a list, unless set to its keyword. */
export type RoleSettings = Partial<Record<RoleName, RoleValue>>;
/** Where a role's value came from, highest precedence first. */
export type RoleSource = 'flag' | 'env' | 'repo' | 'saved' | 'default';
export type ResolvedRole<V extends RoleValue = RoleValue> = { value: V; source: RoleSource };

/** Who plays each code-council role in a run, and where that came from. Recorded on every code run. */
export type CodeRoleMap = {
  /** Tailors the rubric and phrases reframe questions. Default: the first implementer. */
  planner: ResolvedRole<string>;
  /** The candidates. Default: the installed, signed-in CLIs. */
  implementer: ResolvedRole<string[]>;
  /** At most one per model family. Default `same-as-implementer`: the first candidate of each candidate family. */
  adversary: ResolvedRole<string[] | typeof ROLE_KEYWORDS.adversary>;
  /** Judges ties and names grafts. Default `auto`: a usable CLI of another family than the candidates it reads. */
  judge: ResolvedRole<string>;
  /** Folds in each graft. Default `winner`: the base's CLI and model. */
  integrator: ResolvedRole<string>;
};

export type RoleMap = CodeRoleMap & { juror: ResolvedRole<string[]>; chairman: ResolvedRole<string> };

export class RolesValidationError extends Error {
  constructor(readonly where: string, readonly problems: string[]) {
    super(`${where}: ${problems.join('; ')}`);
    this.name = 'RolesValidationError';
  }
}

export function isListRole(role: RoleName): boolean {
  return LIST_ROLES.includes(role);
}

function isRoleName(value: string): value is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(value);
}

/** The model family of an agent CLI spec, or null when it is unknown (OpenCode). */
export function specFamily(spec: string): string | null {
  const member = parseCouncilMember(spec);
  return member.kind === 'cli' ? getProviderInfo(member.cli)?.family ?? null : null;
}

/** `codex:gpt-5.2` → `{ provider: 'codex', model: 'gpt-5.2' }`. */
export function specAgent(spec: string): { provider: string; model?: string } {
  const member = parseCouncilMember(spec);
  if (member.kind !== 'cli') throw new Error(`"${spec}" is not an agent CLI`);
  return { provider: member.cli, ...(member.model ? { model: member.model } : {}) };
}

/** The problem with one member of `role`, or null. Code roles need an agent CLI; jurors and the chairman may be OpenRouter ids. */
function memberProblem(role: RoleName, member: unknown): string | null {
  if (typeof member !== 'string' || !member.trim()) return `${role}: every member must be a non-empty string`;
  const spec = member.trim();
  const head = spec.split(':')[0];
  if (isProviderId(head)) return spec.includes(':') && !spec.slice(head.length + 1).trim() ? `${role}: "${spec}" has an empty model` : null;
  if (role === 'juror' || role === 'chairman') return null;
  return `${role}: "${spec}" is not an agent CLI (use ${PROVIDER_IDS.join(', ')}, optionally with :model)`;
}

/**
 * Validates roles from one source (a `roles:` mapping, saved config or flags). Lists are trimmed; a single member
 * for a list role becomes a list of one. Throws a `RolesValidationError` naming every problem at once.
 */
export function validateRoles(raw: unknown, where: string): RoleSettings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RolesValidationError(where, ['must map role names to members']);
  const problems: string[] = [];
  const settings: RoleSettings = {};
  for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRoleName(role)) {
      problems.push(`unknown role "${role}" (use ${ROLE_NAMES.join(', ')})`);
      continue;
    }
    const keyword: string | undefined = (ROLE_KEYWORDS as Record<string, string>)[role];
    if (keyword !== undefined && value === keyword) {
      settings[role] = keyword;
      continue;
    }
    const members = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) && !isListRole(role)) {
      problems.push(`${role}: takes one member, not a list`);
      continue;
    }
    if (members.length === 0) {
      problems.push(`${role}: needs at least one member`);
      continue;
    }
    if (keyword !== undefined && members.includes(keyword)) {
      problems.push(`${role}: "${keyword}" cannot be listed with other members`);
      continue;
    }
    const found = members.map((m) => memberProblem(role, m)).filter((p) => p !== null);
    if (found.length > 0) {
      problems.push(...found);
      continue;
    }
    const specs = members.map((m) => (m as string).trim());
    if (role === 'adversary') {
      const families = specs.map((s) => specFamily(s) ?? specAgent(s).provider);
      const twice = families.find((f, i) => families.indexOf(f) !== i);
      if (twice) {
        problems.push(`adversary: two members of the ${twice} family (one adversary per family)`);
        continue;
      }
    }
    settings[role] = isListRole(role) ? specs : specs[0];
  }
  if (problems.length > 0) throw new RolesValidationError(where, problems);
  return settings;
}

/**
 * Reads the `roles:` section of `.concilium/factory.yaml`. The other sections belong to later milestones and are
 * not read. Throws naming the file and every problem.
 */
export function parseFactoryRoles(text: string): RoleSettings {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new RolesValidationError(FACTORY_CONFIG, [`not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`]);
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new RolesValidationError(FACTORY_CONFIG, ['must be a mapping']);
  return validateRoles((doc as Record<string, unknown>).roles, `${FACTORY_CONFIG} roles`);
}

/**
 * Reads `--role <role>=<members>` flags. A list role's members are split on commas and repeated flags add to the
 * list; a single role given twice is an error.
 */
export function parseRoleFlags(flags: readonly string[], where = '--role'): RoleSettings {
  const problems: string[] = [];
  const raw: Record<string, string | string[]> = {};
  for (const flag of flags) {
    const eq = flag.indexOf('=');
    const role = eq === -1 ? '' : flag.slice(0, eq).trim();
    if (!role) {
      problems.push(`"${flag}" must be <role>=<member>`);
      continue;
    }
    const value = flag.slice(eq + 1).trim();
    if (isRoleName(role) && isListRole(role) && value !== (ROLE_KEYWORDS as Record<string, string>)[role]) {
      const prev = raw[role];
      raw[role] = [...(Array.isArray(prev) ? prev : []), ...value.split(',').map((s) => s.trim()).filter(Boolean)];
    } else if (role in raw) {
      problems.push(`${role}: given more than once`);
    } else {
      raw[role] = value;
    }
  }
  if (problems.length > 0) throw new RolesValidationError(where, problems);
  return validateRoles(raw, where);
}

/** The highest-precedence source that sets `role`, or null. */
export function pickRole(role: RoleName, layers: readonly (readonly [RoleSource, RoleSettings])[]): ResolvedRole | null {
  for (const [source, settings] of layers) {
    const value = settings[role];
    if (value !== undefined) return { value, source };
  }
  return null;
}

/**
 * Fills in the code roles from the configured layers, highest first, with the defaults: the given implementers,
 * the first implementer as planner, and the keyword behaviors for the rest.
 */
export function resolveCodeRoles(layers: readonly (readonly [RoleSource, RoleSettings])[], defaultImplementers: () => string[]): CodeRoleMap {
  const pick = <V extends RoleValue>(role: CodeRoleName) => pickRole(role, layers) as ResolvedRole<V> | null;
  const implementer = pick<string[]>('implementer') ?? { value: defaultImplementers(), source: 'default' };
  return {
    planner: pick<string>('planner') ?? { value: implementer.value[0] ?? '', source: 'default' },
    implementer,
    adversary: pick<string[] | typeof ROLE_KEYWORDS.adversary>('adversary') ?? { value: ROLE_KEYWORDS.adversary, source: 'default' },
    judge: pick<string>('judge') ?? { value: ROLE_KEYWORDS.judge, source: 'default' },
    integrator: pick<string>('integrator') ?? { value: ROLE_KEYWORDS.integrator, source: 'default' },
  };
}

/** The defaults a code run uses when it is given only its candidates. */
export function defaultCodeRoles(implementers: string[]): CodeRoleMap {
  return resolveCodeRoles([], () => implementers);
}

/** What the role map lets happen that the cross-family rule warns about. Nothing here stops a run. */
export function roleWarnings(roles: CodeRoleMap): string[] {
  const judge = roles.judge.value;
  if (judge === ROLE_KEYWORDS.judge) return [];
  const family = specFamily(judge);
  const families = [...new Set(roles.implementer.value.map((s) => specFamily(s) ?? specAgent(s).provider))];
  if (family === null) return [`judge ${judge} is of an unknown family, so every judgment and graft pick it makes is flagged same-family`];
  if (families.includes(family)) return [`judge ${judge} is of an implementer family (${family}), so ties among ${family} candidates are judged same-family and flagged`];
  return [];
}
