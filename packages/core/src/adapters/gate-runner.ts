/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { planGates, type GatePlan, type GateResult, type InstallStep, type StepResult } from '../domain/verification/gates.js';
import { checkIntegrity, DEPENDENCY_MANIFEST, parseDiff, type IntegrityFinding, type ManifestChange } from '../domain/verification/integrity.js';
import { streamSubprocess } from './cli/subprocess.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('gates');
const execFileAsync = promisify(execFile);

/** Characters of output kept per step: the end, where failures are reported. */
export const OUTPUT_LIMIT = 8000;

/** Never handed to code from the target repo: credentials, and npm's own settings inherited from a parent `npm run`. */
const SECRET_VAR = /(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?)$/i;
const GIT_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX'];

/** What one worktree produced: its install step, if any ran, and every gate, all at `sha`. */
export type LaneResult = { lane: string; sha: string; install: StepResult | null; gates: GateResult[] };

export function gateEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { CI: '1' };
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_VAR.test(name) || name.startsWith('npm_') || GIT_LOCATION_VARS.includes(name)) continue;
    clean[name] = value;
  }
  return clean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: gateEnv(), maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Tier 1 gates and Tier 0 integrity checks for candidate worktrees. Gates are shell commands run in a worktree with
 * a scrubbed environment and a wall-clock limit; integrity checks read the git diff between two commits.
 */
export class GateRunner {
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: { env?: NodeJS.ProcessEnv } = {}) {
    this.env = gateEnv(options.env);
  }

  /** The gates for the tree checked out in `dir`: its `.concilium/verify.yaml`, or what detection finds. */
  plan(dir: string): GatePlan {
    return planGates((path) => {
      try {
        return readFileSync(join(dir, path), 'utf8');
      } catch {
        return null;
      }
    });
  }

  /** Installs dependencies when the plan says so, then runs every gate, one at a time, in `dir`. */
  async runLane(lane: string, dir: string, plan: GatePlan, options: { signal?: AbortSignal; onGate?: (result: GateResult) => void } = {}): Promise<LaneResult> {
    const sha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const install = await this.install(dir, sha, plan.install, options.signal);
    const gates: GateResult[] = [];
    for (const gate of plan.gates) {
      const result = await this.runStep(gate.name, gate.command, dir, sha, gate.timeoutMs, options.signal);
      log.debug(`${lane} ${gate.name}: ${result.outcome} in ${result.durationMs}ms`);
      gates.push(result);
      options.onGate?.(result);
    }
    return { lane, sha, install, gates };
  }

  /** Tier 0 checks on `baseSha..headSha`, in the repo at `repoDir`. */
  async integrity(repoDir: string, baseSha: string, headSha: string): Promise<IntegrityFinding[]> {
    const diff = await git(repoDir, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', baseSha, headSha]);
    const files = parseDiff(diff);
    const manifests: ManifestChange[] = [];
    for (const file of files.filter((f) => DEPENDENCY_MANIFEST.test(f.path) && f.status !== 'deleted')) {
      manifests.push({ path: file.path, base: await this.show(repoDir, baseSha, file.oldPath), head: await this.show(repoDir, headSha, file.path) });
    }
    return checkIntegrity(files, manifests);
  }

  private async show(repoDir: string, sha: string, path: string): Promise<string | null> {
    return git(repoDir, ['show', `${sha}:${path}`]).catch(() => null);
  }

  private async install(dir: string, sha: string, step: InstallStep | null, signal?: AbortSignal): Promise<StepResult | null> {
    if (!step || (step.skipIfExists && existsSync(join(dir, step.skipIfExists)))) return null;
    return this.runStep('install', step.command, dir, sha, step.timeoutMs, signal);
  }

  private async runStep(name: string, command: string, cwd: string, sha: string, timeoutMs: number, signal?: AbortSignal): Promise<StepResult> {
    const startedAt = Date.now();
    let output = '';
    let truncated = false;
    for await (const item of streamSubprocess({ command: 'sh', args: ['-c', command], cwd, env: this.env, timeoutMs, signal, detectRateLimit: () => null })) {
      if (item.kind === 'line') {
        output += `${item.text}\n`;
        if (output.length > OUTPUT_LIMIT) {
          output = output.slice(-OUTPUT_LIMIT);
          truncated = true;
        }
        continue;
      }
      const outcome: StepResult['outcome'] = item.outcome === 'timeout' ? 'timeout'
        : item.outcome !== 'exited' ? 'error'
        : item.code === 0 ? 'pass' : 'fail';
      if (item.error) output += `${item.error}\n`;
      return { name, command, sha, outcome, exitCode: item.code, durationMs: Date.now() - startedAt, output, truncated };
    }
    throw new Error('unreachable: streamSubprocess always ends with an exit item');
  }
}
