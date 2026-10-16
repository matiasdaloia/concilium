/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { parseBrief, type Brief } from '../../domain/driver/brief.js';
import type { NormalizedEvent } from '../../domain/driver/normalized-event.js';
import type { CliAuth, CliDetection, DriverRunOptions, HeadlessCliDriver } from '../../ports/headless-cli-driver.js';
import { runClaudeCode } from './claude-code.js';
import { runCodex } from './codex.js';
import { runGemini } from './gemini.js';
import { captureSubprocess } from './subprocess.js';

export const HEADLESS_CLI_IDS = ['claude', 'codex', 'gemini', 'opencode'] as const;
export type HeadlessCliId = (typeof HEADLESS_CLI_IDS)[number];

export type AuthStatus = { auth: CliAuth; notes?: string };
export type StatusOutput = { code: number | null; stdout: string; stderr: string };

const PROBE_TIMEOUT_MS = 10_000;

const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;

export function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0] ?? (output.trim().split('\n')[0] || undefined);
}

/** `claude auth status` prints JSON such as `{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}`. */
export function parseClaudeAuthStatus(out: StatusOutput): AuthStatus {
  let status: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
  try {
    status = JSON.parse(out.stdout) as typeof status;
  } catch {
    return { auth: 'unknown', notes: '`claude auth status` printed no JSON' };
  }
  if (status.loggedIn === false) return { auth: 'none', notes: 'not logged in: run `claude` and sign in' };
  const method = String(status.authMethod ?? '');
  const plan = typeof status.subscriptionType === 'string' ? `plan: ${status.subscriptionType}` : undefined;
  if (/claude\.ai|oauth/i.test(method)) return { auth: 'subscription', ...(plan && { notes: plan }) };
  if (/api|console/i.test(method)) return { auth: 'api-key' };
  return { auth: 'unknown', ...(method && { notes: `auth method: ${method}` }) };
}

/** `codex login status` prints e.g. "Logged in using ChatGPT" or "Not logged in" (on stdout or stderr, depending on the version). */
export function parseCodexLoginStatus(out: StatusOutput): AuthStatus {
  const text = `${out.stdout}\n${out.stderr}`;
  if (/not logged in/i.test(text)) return { auth: 'none', notes: 'not logged in: run `codex login`' };
  if (/chatgpt/i.test(text)) return { auth: 'subscription' };
  if (/api key/i.test(text)) return { auth: 'api-key' };
  return { auth: 'unknown' };
}

/** `opencode auth list` prints one `●  <Provider> <type>` row per stored credential, then the provider env vars it found. */
export function parseOpenCodeAuthList(out: StatusOutput): AuthStatus {
  const lines = out.stdout.replace(ANSI, '').split('\n');
  const oauth = lines.flatMap((line) => line.match(/●\s+(.+?)\s+oauth\s*$/i)?.[1] ?? []);
  if (oauth.length > 0) {
    const anthropic = oauth.some((p) => /anthropic|claude/i.test(p));
    const notes = `oauth: ${oauth.join(', ')}${anthropic ? '; Anthropic terms do not cover Claude subscription login in OpenCode' : ''}`;
    return { auth: 'subscription', notes };
  }
  if (lines.some((line) => /●\s+.+\s+api\s*$/i.test(line) || /_API_KEY\b/.test(line))) return { auth: 'api-key' };
  if (lines.some((line) => /\b0 credentials\b/i.test(line))) return { auth: 'none', notes: 'no credentials: run `opencode auth login`' };
  return { auth: 'unknown' };
}

/** Gemini CLI has no auth status command, so only the documented API key variables are checked (for presence, never read). */
export function geminiAuthFromEnv(env: NodeJS.ProcessEnv): AuthStatus {
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return { auth: 'api-key' };
  if (env.GOOGLE_GENAI_USE_VERTEXAI === 'true') return { auth: 'api-key', notes: 'Vertex AI' };
  return { auth: 'unknown', notes: 'no auth status command; a Google sign-in is checked on first run' };
}

type CliDefinition = {
  id: HeadlessCliId;
  command: string;
  /** A non-secret status command and its parser, or a check of the environment. */
  auth: { args: string[]; parse: (out: StatusOutput) => AuthStatus } | { fromEnv: (env: NodeJS.ProcessEnv) => AuthStatus };
  /** The CLI's one-shot headless run. Missing until that CLI's driver lands. */
  run?: typeof runClaudeCode;
};

const DEFINITIONS: Record<HeadlessCliId, CliDefinition> = {
  claude: { id: 'claude', command: 'claude', auth: { args: ['auth', 'status'], parse: parseClaudeAuthStatus }, run: runClaudeCode },
  codex: { id: 'codex', command: 'codex', auth: { args: ['login', 'status'], parse: parseCodexLoginStatus }, run: runCodex },
  gemini: { id: 'gemini', command: 'gemini', auth: { fromEnv: geminiAuthFromEnv }, run: runGemini },
  opencode: { id: 'opencode', command: 'opencode', auth: { args: ['auth', 'list'], parse: parseOpenCodeAuthList } },
};

/** Drives an installed agent CLI. `run` works for Claude Code, Codex and Gemini CLI so far; OpenCode arrives in M1.5. */
export class CliDriver implements HeadlessCliDriver {
  readonly id: HeadlessCliId;

  constructor(
    private readonly definition: CliDefinition,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.id = definition.id;
  }

  async detect(): Promise<CliDetection> {
    const { command, auth } = this.definition;
    const probe = (args: string[]) => captureSubprocess({ command, args, env: this.env, timeoutMs: PROBE_TIMEOUT_MS });

    const versionOut = await probe(['--version']);
    if (versionOut.outcome === 'spawn_error') return { installed: false };
    const version = parseVersion(versionOut.stdout || versionOut.stderr);

    if ('fromEnv' in auth) return { installed: true, version, ...auth.fromEnv(this.env) };
    const statusOut = await probe(auth.args);
    if (statusOut.outcome !== 'exited') {
      return { installed: true, version, auth: 'unknown', notes: `\`${command} ${auth.args.join(' ')}\` ${statusOut.outcome}` };
    }
    return { installed: true, version, ...auth.parse(statusOut) };
  }

  async *run(brief: Brief, opts: DriverRunOptions): AsyncGenerator<NormalizedEvent> {
    const { command, run } = this.definition;
    if (!run) throw new Error(`${this.id}: headless run is not implemented yet`);
    yield* run({ command, env: this.env, brief: parseBrief(brief), opts });
  }
}

/** One driver per known CLI, in a stable order. */
export function createHeadlessCliDrivers(env: NodeJS.ProcessEnv = process.env): CliDriver[] {
  return HEADLESS_CLI_IDS.map((id) => new CliDriver(DEFINITIONS[id], env));
}
