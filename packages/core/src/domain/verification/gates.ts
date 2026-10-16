/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { parse as parseYaml } from 'yaml';

/** The target repo's own gate config, committed at the run's base. */
export const VERIFY_CONFIG = '.concilium/verify.yaml';

/** Wall-clock limit for one gate command; gates can be silent for minutes. */
export const GATE_TIMEOUT_MS = 10 * 60_000;

/** Wall-clock limit for installing a worktree's dependencies. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** A shell command that must exit 0, such as `npm run test` or `go vet ./...`. */
export type Gate = { name: string; command: string; timeoutMs: number };

/** How to install a worktree's dependencies. Skipped when `skipIfExists` (a path in the worktree) exists. */
export type InstallStep = { command: string; skipIfExists?: string; timeoutMs: number };

/** The gates every lane runs, decided once from the base commit so a candidate cannot change them. */
export type GatePlan = {
  source: 'verify.yaml' | 'detected';
  gates: Gate[];
  install: InstallStep | null;
  /** E.g. why `verify.yaml` was ignored. */
  notes: string[];
};

/** One command run in one worktree, at one commit. */
export type StepResult = {
  name: string;
  command: string;
  /** The commit checked out where the command ran. */
  sha: string;
  /** `error`: the command could not be started. */
  outcome: 'pass' | 'fail' | 'timeout' | 'error';
  exitCode: number | null;
  durationMs: number;
  /** The end of stdout and stderr, interleaved. */
  output: string;
  truncated: boolean;
};

export type GateResult = StepResult;

/** `baseline-failure`: it fails on the base too, so it is reported and not held against the candidate. */
export type GateVerdict = GateResult & { verdict: 'pass' | 'new-failure' | 'baseline-failure' };

/** Reads a file at the root of the tree being planned, or null when it does not exist. */
export type ReadFile = (path: string) => string | null;

const GATE_SCRIPTS = ['typecheck', 'lint', 'test'] as const;

function makeTargets(makefile: string): Set<string> {
  const targets = new Set<string>();
  for (const line of makefile.split('\n')) {
    const match = /^([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)*)\s*:(?!=)/.exec(line);
    if (match) for (const target of match[1].split(/\s+/)) targets.add(target);
  }
  return targets;
}

function isPytestProject(read: ReadFile): boolean {
  return read('pytest.ini') !== null
    || read('conftest.py') !== null
    || /^\[tool\.pytest/m.test(read('pyproject.toml') ?? '')
    || /^\[tool:pytest\]/m.test(read('setup.cfg') ?? '')
    || /^\[pytest\]/m.test(read('tox.ini') ?? '');
}

/**
 * Gates found in the repo: `package.json` scripts named typecheck, lint and test, the same Makefile targets,
 * `go vet` and `go test` for a Go module, `pytest`, and `cargo test`.
 */
export function detectGates(read: ReadFile): Gate[] {
  const gates: Gate[] = [];
  const add = (name: string, command: string) => gates.push({ name, command, timeoutMs: GATE_TIMEOUT_MS });

  const packageJson = read('package.json');
  if (packageJson !== null) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts ?? {};
    } catch {
      // A package.json that does not parse has no scripts to run.
    }
    for (const script of GATE_SCRIPTS) if (typeof scripts[script] === 'string') add(`npm:${script}`, `npm run ${script}`);
  }
  const makefile = read('Makefile') ?? read('makefile') ?? read('GNUmakefile');
  if (makefile !== null) {
    const targets = makeTargets(makefile);
    for (const target of GATE_SCRIPTS) if (targets.has(target)) add(`make:${target}`, `make ${target}`);
  }
  if (read('go.mod') !== null) {
    add('go:vet', 'go vet ./...');
    add('go:test', 'go test ./...');
  }
  if (isPytestProject(read)) add('pytest', 'python -m pytest');
  if (read('Cargo.toml') !== null) add('cargo:test', 'cargo test');
  return gates;
}

/** `npm ci` when there is a lockfile and no `node_modules`. Other ecosystems fetch their own dependencies. */
export function detectInstall(read: ReadFile): InstallStep | null {
  return read('package-lock.json') !== null ? { command: 'npm ci', skipIfExists: 'node_modules', timeoutMs: INSTALL_TIMEOUT_MS } : null;
}

function seconds(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${field}: must be a positive number of seconds`);
  return value * 1000;
}

/**
 * Parses `.concilium/verify.yaml`:
 *
 * ```yaml
 * install: npm ci          # optional; `false` installs nothing
 * gates:
 *   test: npm test
 *   lint:
 *     run: npm run lint
 *     timeout: 300         # seconds, default 600
 * ```
 *
 * `gates` replaces the detected gates; without it they are kept. Throws naming the first problem.
 */
export function parseVerifyConfig(text: string): { gates?: Gate[]; install?: InstallStep | null } {
  const doc: unknown = parseYaml(text);
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('must be a mapping');
  const { gates, install, ...rest } = doc as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) throw new Error(`unknown key "${unknown[0]}" (use gates and install)`);

  const config: { gates?: Gate[]; install?: InstallStep | null } = {};
  if (install !== undefined) {
    if (install === false || install === null) config.install = null;
    else if (typeof install === 'string' && install.trim()) config.install = { command: install.trim(), timeoutMs: INSTALL_TIMEOUT_MS };
    else throw new Error('install: must be a command or false');
  }
  if (gates !== undefined) {
    if (typeof gates !== 'object' || gates === null || Array.isArray(gates)) throw new Error('gates: must map gate names to commands');
    config.gates = Object.entries(gates as Record<string, unknown>).map(([name, value]) => {
      if (typeof value === 'string' && value.trim()) return { name, command: value.trim(), timeoutMs: GATE_TIMEOUT_MS };
      const spec = (typeof value === 'object' && value !== null ? value : {}) as { run?: unknown; timeout?: unknown };
      if (typeof spec.run !== 'string' || !spec.run.trim()) throw new Error(`gates.${name}: must be a command, or have a "run" command`);
      return { name, command: spec.run.trim(), timeoutMs: spec.timeout === undefined ? GATE_TIMEOUT_MS : seconds(spec.timeout, `gates.${name}.timeout`) };
    });
  }
  return config;
}

/** The gates and install step for a tree: `.concilium/verify.yaml` where it says so, detection for the rest. */
export function planGates(read: ReadFile): GatePlan {
  const text = read(VERIFY_CONFIG);
  if (text !== null) {
    try {
      const config = parseVerifyConfig(text);
      return {
        source: 'verify.yaml',
        gates: config.gates ?? detectGates(read),
        install: config.install === undefined ? detectInstall(read) : config.install,
        notes: [],
      };
    } catch (err) {
      const note = `${VERIFY_CONFIG} ignored, using detected gates: ${err instanceof Error ? err.message : String(err)}`;
      return { source: 'detected', gates: detectGates(read), install: detectInstall(read), notes: [note] };
    }
  }
  return { source: 'detected', gates: detectGates(read), install: detectInstall(read), notes: [] };
}

/** "No new failures against base": a gate that fails on the base too is a baseline failure, not the candidate's. */
export function judgeGates(base: GateResult[], candidate: GateResult[]): GateVerdict[] {
  return candidate.map((result) => {
    if (result.outcome === 'pass') return { ...result, verdict: 'pass' };
    const onBase = base.find((b) => b.name === result.name);
    return { ...result, verdict: onBase && onBase.outcome !== 'pass' ? 'baseline-failure' : 'new-failure' };
  });
}
