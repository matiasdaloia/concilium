/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { parse as parseYaml } from 'yaml';
import { agentFamily, familyKey, isProviderId } from '../agent/providers.js';
import { parseCouncilMember } from '../council/council-members.js';
import { FACTORY_CONFIG, roleOrigin, RolesValidationError, violation, type RoleOrigin, type RoleViolation } from './role-rules.js';

export { FACTORY_CONFIG } from './role-rules.js';

/** The code-council roles. Each is played by agent CLIs given as `cli[:model]`. */
export const CODE_ROLES = ['planner', 'implementer', 'adversary', 'judge', 'integrator'] as const;
export type CodeRoleName = (typeof CODE_ROLES)[number];

/** The roles of shipping a run (`concilium pr`, `verify-pr`), resolved when they run, not recorded on the run. */
export const SHIP_ROLES = ['verifier'] as const;
export type ShipRoleName = (typeof SHIP_ROLES)[number];

/** Every role: the code council's, shipping's, then the plan council's jurors and chairman (which may also be OpenRouter ids). */
export const ROLE_NAMES = [...CODE_ROLES, ...SHIP_ROLES, 'juror', 'chairman'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Roles played by a list of members; the others take one. */
const LIST_ROLES: readonly RoleName[] = ['implementer', 'adversary', 'juror'];

/** Per role, the word that names its built-in behavior instead of a member. */
export const ROLE_KEYWORDS = { adversary: 'same-as-implementer', judge: 'auto', integrator: 'winner', verifier: 'auto' } as const;

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

/**
 * Every role. `verifier` re-verifies a run before its PR; default `auto`: the first usable CLI outside the author
 * families. A configured verifier outside them goes first.
 */
export type RoleMap = CodeRoleMap & { verifier: ResolvedRole<string>; juror: ResolvedRole<string[]>; chairman: ResolvedRole<string> };

export function isListRole(role: RoleName): boolean {
  return LIST_ROLES.includes(role);
}

function isRoleName(value: string): value is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(value);
}

/** The model family of an agent CLI spec (`agentFamily`), or null when it is unknown (OpenCode without a known vendor). */
export function specFamily(spec: string): string | null {
  const member = parseCouncilMember(spec);
  return member.kind === 'cli' ? agentFamily(member.cli, member.model) : null;
}

/** `codex:gpt-5.2` → `{ provider: 'codex', model: 'gpt-5.2' }`. */
export function specAgent(spec: string): { provider: string; model?: string } {
  const member = parseCouncilMember(spec);
  if (member.kind !== 'cli') throw new Error(`"${spec}" is not an agent CLI`);
  return { provider: member.cli, ...(member.model ? { model: member.model } : {}) };
}

/** The family a member counts toward: its model family, or its provider id when that is unknown. */
function specFamilyKey(spec: string): string {
  const agent = specAgent(spec);
  return familyKey(agent.provider, agent.model);
}

/** The violation of one member of `role`, or null. Code roles need an agent CLI; jurors and the chairman may be OpenRouter ids. */
function memberViolation(role: RoleName, member: unknown, origin: RoleOrigin): RoleViolation | null {
  if (typeof member !== 'string' || !member.trim()) return violation('unknown-cli', origin, role, 'every member must be a non-empty string');
  const spec = member.trim();
  const head = spec.split(':')[0];
  if (isProviderId(head)) {
    return spec.includes(':') && !spec.slice(head.length + 1).trim() ? violation('empty-model', origin, role, `"${spec}" has an empty model`) : null;
  }
  if (role === 'juror' || role === 'chairman') return null;
  return violation('unknown-cli', origin, role, `"${spec}" is not an agent CLI`);
}

/**
 * Validates roles from one source (a `roles:` mapping, saved config or flags). Lists are trimmed; a single member
 * for a list role becomes a list of one. Throws a `RolesValidationError` naming every violation at once.
 */
export function validateRoles(raw: unknown, origin: RoleOrigin): RoleSettings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RolesValidationError([violation('roles-not-a-mapping', origin, null, 'must map role names to members')]);
  }
  const found: RoleViolation[] = [];
  const settings: RoleSettings = {};
  for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRoleName(role)) {
      found.push({ ...violation('unknown-role', origin, null, `unknown role "${role}"`, `use ${ROLE_NAMES.join(', ')}`), at: origin.at(role as RoleName) });
      continue;
    }
    const keyword: string | undefined = (ROLE_KEYWORDS as Record<string, string>)[role];
    if (keyword !== undefined && value === keyword) {
      settings[role] = keyword;
      continue;
    }
    const members = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) && !isListRole(role)) {
      found.push(violation('list-for-single-role', origin, role, 'takes one member, not a list'));
      continue;
    }
    if (members.length === 0) {
      found.push(violation('no-members', origin, role, 'needs at least one member'));
      continue;
    }
    if (keyword !== undefined && members.includes(keyword)) {
      found.push(violation('keyword-with-members', origin, role, `"${keyword}" cannot be listed with other members`));
      continue;
    }
    const bad = members.map((m) => memberViolation(role, m, origin)).filter((v) => v !== null);
    if (bad.length > 0) {
      found.push(...bad);
      continue;
    }
    const specs = members.map((m) => (m as string).trim());
    if (role === 'adversary') {
      const families = specs.map(specFamilyKey);
      const twice = families.find((f, i) => families.indexOf(f) !== i);
      if (twice) {
        found.push(violation('adversary-family-twice', origin, role, `two members of the ${twice} family`));
        continue;
      }
    }
    settings[role] = isListRole(role) ? specs : specs[0];
  }
  if (found.length > 0) throw new RolesValidationError(found);
  return settings;
}

/**
 * Reads the `roles:` section of the `.concilium/factory.yaml` at `path`. The other sections belong to later
 * milestones and are not read. Throws naming the file and every violation.
 */
export function parseFactoryRoles(text: string, path: string = FACTORY_CONFIG): RoleSettings {
  const origin = roleOrigin.file('repo', path);
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new RolesValidationError([violation('factory-yaml', origin, null, `not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)]);
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new RolesValidationError([violation('factory-yaml', origin, null, 'must be a mapping')]);
  return validateRoles((doc as Record<string, unknown>).roles, origin);
}

/**
 * Reads `--role <role>=<members>` flags. A list role's members are split on commas and repeated flags add to the
 * list; a single role given twice is an error.
 */
export function parseRoleFlags(flags: readonly string[], origin: RoleOrigin = roleOrigin.flag()): RoleSettings {
  const found: RoleViolation[] = [];
  const raw: Record<string, string | string[]> = {};
  for (const flag of flags) {
    const eq = flag.indexOf('=');
    const role = eq === -1 ? '' : flag.slice(0, eq).trim();
    if (!role) {
      found.push(violation('flag-syntax', origin, null, `"${flag}" must be <role>=<member>`));
      continue;
    }
    const value = flag.slice(eq + 1).trim();
    if (isRoleName(role) && isListRole(role) && value !== (ROLE_KEYWORDS as Record<string, string>)[role]) {
      const prev = raw[role];
      raw[role] = [...(Array.isArray(prev) ? prev : []), ...value.split(',').map((s) => s.trim()).filter(Boolean)];
    } else if (role in raw) {
      found.push(violation('flag-repeated', origin, role as RoleName, 'given more than once'));
    } else {
      raw[role] = value;
    }
  }
  if (found.length > 0) throw new RolesValidationError(found);
  return validateRoles(raw, origin);
}

/** The commands that take `--role`, and the roles each one applies. */
export const ROLE_COMMANDS = {
  code: CODE_ROLES,
  factory: [...CODE_ROLES, 'verifier'],
  pr: SHIP_ROLES,
  'verify-pr': SHIP_ROLES,
  roles: ROLE_NAMES,
} as const satisfies Record<string, readonly RoleName[]>;
export type RoleCommand = keyof typeof ROLE_COMMANDS;

/** Where to set a role that does not apply to a command. */
function whereToSet(role: RoleName): string {
  if (role === 'juror' || role === 'chairman') return 'set jurors and the chairman with `concilium run --juror-models` and `--chairman`';
  if (role === 'verifier') return 'set it with `concilium pr --role verifier=...` or `verify-pr --role verifier=...`';
  return 'set it with `concilium code --role` or `factory --role`';
}

/**
 * The role flags of `command`: its `--role` flags and `--agents` (the implementer list). Throws a
 * `RolesValidationError` naming every violation: both `--agents` and `--role implementer`, a malformed flag, and a
 * role the command does not apply.
 */
export function parseCommandRoles(command: RoleCommand, input: { roles?: readonly string[]; agents?: string }): RoleSettings {
  const found: RoleViolation[] = [];
  const parse = (flags: readonly string[], origin: RoleOrigin): RoleSettings => {
    try {
      return parseRoleFlags(flags, origin);
    } catch (err) {
      if (!(err instanceof RolesValidationError)) throw err;
      found.push(...err.violations);
      return {};
    }
  };
  const roles = input.roles ?? [];
  const flags = parse(roles, roleOrigin.flag());
  if (input.agents !== undefined) {
    if (roles.some((r) => r.split('=')[0].trim() === 'implementer')) {
      found.push(violation('agents-and-implementer', roleOrigin.flag(), 'implementer', '--agents and --role implementer=... set the same role'));
    } else {
      Object.assign(flags, parse([`implementer=${input.agents}`], { source: 'flag', at: () => '--agents' }));
    }
  }
  const applies: readonly RoleName[] = ROLE_COMMANDS[command];
  for (const role of new Set(roles.map((r) => r.split('=')[0].trim()).filter(isRoleName))) {
    if (!applies.includes(role)) found.push(violation('role-not-applicable', roleOrigin.flag(), role, `${role} does not apply to concilium ${command}`, whereToSet(role)));
  }
  if (found.length > 0) throw new RolesValidationError(found);
  return flags;
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

/** The verifier from the configured layers, highest first, or `auto`. */
export function resolveVerifierRole(layers: readonly (readonly [RoleSource, RoleSettings])[]): ResolvedRole<string> {
  return (pickRole('verifier', layers) as ResolvedRole<string> | null) ?? { value: ROLE_KEYWORDS.verifier, source: 'default' };
}

/** The defaults a code run uses when it is given only its candidates. */
export function defaultCodeRoles(implementers: string[]): CodeRoleMap {
  return resolveCodeRoles([], () => implementers);
}

/**
 * The cross-family rules (layer 3 C4) on resolved roles. A configured judge of an unknown family, or of a family with
 * two or more implementers (they can tie among themselves, and can be all the graft picker reads), is an error; of a
 * family with one implementer, a warning. A configured verifier of an unknown family, or of a family that writes the
 * code, is an error: `authors` once the code exists (`pr`, `verify-pr`), else every implementer family and a
 * configured integrator's. `auto` is never a violation: the run picks cross-family and flags what it cannot.
 */
export function checkRoleFamilies(input: { roles?: CodeRoleMap; verifier?: ResolvedRole<string>; authors?: readonly string[] }): RoleViolation[] {
  const { roles, verifier } = input;
  const found: RoleViolation[] = [];
  const implementers = roles?.implementer.value.map(specFamilyKey) ?? [];
  if (roles && roles.judge.value !== ROLE_KEYWORDS.judge) {
    const { value: judge, source } = roles.judge;
    const origin = roleOrigin.resolved(source);
    const family = specFamily(judge);
    const seats = implementers.filter((f) => f === family).length;
    if (family === null) {
      found.push(violation('unknown-family', origin, 'judge', `judge ${judge} is of an unknown model family, so no judgment it makes can be shown cross-family`));
    } else if (seats >= 2) {
      found.push(violation('judge-judges-itself', origin, 'judge', `judge ${judge} is of the ${family} family, which has ${seats} implementers, so it can judge a tie of ${family} candidates alone`));
    } else if (seats === 1) {
      found.push(violation('judge-shares-family', origin, 'judge', `judge ${judge} is of an implementer family (${family}), so ties with the ${family} candidate are judged same-family and flagged`));
    }
  }
  if (verifier && verifier.value !== ROLE_KEYWORDS.verifier) {
    const origin = roleOrigin.resolved(verifier.source);
    const family = specFamily(verifier.value);
    const integrator = roles && roles.integrator.value !== ROLE_KEYWORDS.integrator ? [specFamilyKey(roles.integrator.value)] : [];
    const authors = input.authors ?? [...new Set([...implementers, ...integrator])];
    if (family === null) {
      found.push(violation('unknown-family', origin, 'verifier', `verifier ${verifier.value} is of an unknown model family, so it cannot be shown to be outside the authors`));
    } else if (authors.includes(family)) {
      found.push(violation('verifier-author-family', origin, 'verifier', `verifier ${verifier.value} is of the ${family} family, which ${input.authors ? 'wrote' : 'can write'} the code it verifies (authors: ${authors.join(', ')})`));
    }
  }
  return found;
}
