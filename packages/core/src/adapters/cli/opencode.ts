/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { briefPrompt, type AllowedAction, type Brief } from '../../domain/driver/brief.js';
import type { NormalizedEvent, RunEvent } from '../../domain/driver/normalized-event.js';
import { buildReport, type ReportStatus } from '../../domain/driver/report.js';
import type { DriverRunOptions } from '../../ports/headless-cli-driver.js';
import { createLogger } from '../../shared/logger.js';
import { detectRateLimit, streamSubprocess } from './subprocess.js';

const log = createLogger('opencode');

/** The OpenCode permission keys each brief action unlocks. */
const PERMISSIONS_BY_ACTION: Record<AllowedAction, string[]> = {
  read: ['read', 'grep', 'glob', 'list', 'lsp'],
  write: ['edit'],
  shell: ['bash'],
  network: ['webfetch', 'websearch', 'codesearch'],
};

/** What an isolated run (`DriverRunOptions.isolated`) adds: `--pure` (OpenCode 1.18) runs without external plugins. */
export const OPENCODE_ISOLATED_ARGS = ['--pure'] as const;

/**
 * `opencode run --format json` arguments for a brief. A plan brief runs the built-in `plan` agent, a code brief
 * the `build` agent. `--auto` is never passed, so `run` rejects every permission OpenCode would ask for.
 */
export function openCodeArgs(brief: Brief, model?: string, isolated = false): string[] {
  const args = ['run', '--format=json', `--agent=${brief.mode === 'plan' ? 'plan' : 'build'}`, ...(isolated ? OPENCODE_ISOLATED_ARGS : [])];
  if (model?.trim()) args.push(`--model=${model.trim()}`);
  args.push('--', briefPrompt(brief));
  return args;
}

/**
 * The `OPENCODE_PERMISSION` config for a brief, which OpenCode merges over its agents' own permissions. Tools of
 * actions the brief does not allow are denied. The `plan` agent only denies edits and still allows bash, which has
 * no sandbox, so a plan brief also denies bash to stay read-only. Tools that wait for a user answer are denied too.
 */
export function openCodePermission(brief: Brief): Record<string, 'deny'> {
  const denied = new Set(['question', 'plan_enter', 'plan_exit']);
  const readOnly: AllowedAction[] = ['read', 'network'];
  for (const [action, keys] of Object.entries(PERMISSIONS_BY_ACTION) as [AllowedAction, string[]][]) {
    const allowed = brief.allowedActions.includes(action) && (brief.mode === 'code' || readOnly.includes(action));
    if (!allowed) keys.forEach((key) => denied.add(key));
  }
  return Object.fromEntries([...denied].map((key) => [key, 'deny' as const]));
}

/** What one `run --format json` line means for the run. */
export type OpenCodeLine = {
  events: RunEvent[];
  /** The text of a finished text part. */
  message?: string;
  /** Set by `step_finish`. */
  stepFinished?: boolean;
};

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;

/** The parameter worth showing for OpenCode's built-in tools (`bash`, `read`, `edit`, `glob`, ...). */
function toolDetail(state: Json): string {
  const input = asRecord(state.input);
  for (const key of ['command', 'filePath', 'path', 'pattern', 'url', 'query']) {
    const value = asString(input[key]);
    if (value) return value;
  }
  return asString(state.title);
}

/** Maps one parsed `run --format json` line to normalized events. Unknown line types (`step_start`, `reasoning`) yield nothing. */
export function parseOpenCodeLine(json: unknown): OpenCodeLine {
  const line = asRecord(json);
  const part = asRecord(line.part);
  switch (line.type) {
    case 'text': {
      const text = asString(part.text);
      return text ? { events: [{ type: 'text', text }], message: text } : { events: [] };
    }
    case 'tool_use': {
      const state = asRecord(part.state);
      if (state.status === 'error') log.debug(`opencode tool ${asString(part.tool)} failed: ${asString(state.error)}`);
      const detail = toolDetail(state);
      return { events: [{ type: 'tool', name: asString(part.tool) || 'tool', ...(detail && { detail }) }] };
    }
    case 'step_finish': {
      const tokens = asRecord(part.tokens);
      const cache = asRecord(tokens.cache);
      const cost = asNumber(part.cost);
      // OpenCode counts cached input apart; the reasoning tokens are output.
      const usage = {
        inputTokens: asNumber(tokens.input) + asNumber(cache.read) + asNumber(cache.write),
        outputTokens: asNumber(tokens.output) + asNumber(tokens.reasoning),
        ...(cost > 0 && { costUsd: cost }),
      };
      return { events: [{ type: 'usage', usage }], stepFinished: true };
    }
    case 'error': {
      // A session error: `{ name, data: { message, statusCode?, ... } }`, e.g. an `APIError` from the provider.
      const error = asRecord(line.error);
      const data = asRecord(error.data);
      const message = asString(data.message) || asString(error.name) || 'OpenCode session error';
      const limited = data.statusCode === 429 || detectRateLimit(message) !== null;
      return { events: [limited ? { type: 'rate_limit', message } : { type: 'error', message }] };
    }
    default:
      return { events: [] };
  }
}

/**
 * Runs one brief through `opencode run --format json` under the provider logins stored in OpenCode and streams
 * normalized events. OpenCode must not run on a Claude subscription login (see docs/research/subscription-tos.md);
 * `detect()` warns about one.
 */
export async function* runOpenCode(input: {
  command: string;
  env: NodeJS.ProcessEnv;
  brief: Brief;
  opts: DriverRunOptions;
}): AsyncGenerator<NormalizedEvent> {
  const { command, env, brief, opts } = input;
  const startedAt = Date.now();
  const streamed: RunEvent[] = [];
  let finalText: string | undefined;
  let stepFinished = false;
  // A 429 OpenCode retried may show on stderr; it counts only when the run fails in the end.
  let stderrLimit: { message: string } | undefined;
  let status: ReportStatus = 'ok';

  const emit = (event: RunEvent) => {
    streamed.push(event);
    return event;
  };

  const args = openCodeArgs(brief, opts.model, opts.isolated);
  const childEnv = { ...env, OPENCODE_PERMISSION: JSON.stringify(openCodePermission(brief)) };
  for await (const item of streamSubprocess({ command, args, cwd: opts.cwd, env: childEnv, timeoutMs: opts.timeoutMs, signal: opts.signal })) {
    if (item.kind === 'line') {
      if (item.stream === 'stderr') {
        if (item.rateLimit) stderrLimit = item.rateLimit;
        continue;
      }
      if (item.json === undefined) {
        if (item.text.trim()) log.debug(`ignoring non-JSON stdout line: ${item.text.slice(0, 200)}`);
        continue;
      }
      const parsed = parseOpenCodeLine(item.json);
      if (parsed.message !== undefined) finalText = parsed.message;
      if (parsed.stepFinished) stepFinished = true;
      for (const event of parsed.events) yield emit(event);
      continue;
    }

    const rateLimited = () => streamed.some((e) => e.type === 'rate_limit');
    const failed = () => streamed.some((e) => e.type === 'error');
    if (item.outcome === 'timeout' || item.outcome === 'aborted') {
      status = item.outcome;
      yield emit({ type: 'error', message: `opencode ${item.outcome === 'timeout' ? `timed out after ${opts.timeoutMs}ms` : 'was aborted'}` });
    } else if (item.outcome === 'spawn_error') {
      status = 'error';
      yield emit({ type: 'error', message: `could not start ${command}: ${item.error ?? 'unknown error'}` });
    } else if (item.code === 0 && stepFinished && !rateLimited() && !failed()) {
      status = 'ok';
    } else if (rateLimited() || (stderrLimit && !failed())) {
      status = 'rate_limited';
      if (!rateLimited() && stderrLimit) yield emit({ type: 'rate_limit', ...stderrLimit });
    } else {
      status = 'error';
      if (!failed()) {
        const stderr = item.stderr.map((l) => l.replace(ANSI, '')).filter((l) => l.trim()).slice(-5).join('\n');
        const why = item.code !== 0 ? `opencode exited with code ${item.code}` : 'opencode exited without finishing a step';
        yield emit({ type: 'error', message: stderr ? `${why}: ${stderr}` : why });
      }
    }
  }

  yield {
    type: 'done',
    report: buildReport({
      driverId: 'opencode',
      model: opts.model?.trim() || null,
      status,
      events: streamed,
      durationMs: Date.now() - startedAt,
      // OpenCode may write text between tool calls; the answer is the last text part.
      finalText: status === 'ok' ? (finalText ?? '') : '',
    }),
  };
}
