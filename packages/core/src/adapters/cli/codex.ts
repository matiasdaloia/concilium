/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { briefPrompt, type Brief } from '../../domain/driver/brief.js';
import type { NormalizedEvent, RunEvent } from '../../domain/driver/normalized-event.js';
import { buildReport, type ReportStatus } from '../../domain/driver/report.js';
import type { DriverRunOptions } from '../../ports/headless-cli-driver.js';
import { createLogger } from '../../shared/logger.js';
import { detectRateLimit, streamSubprocess } from './subprocess.js';

const log = createLogger('codex');

/**
 * `codex exec --json` arguments for a brief. A plan brief runs in the read-only sandbox, a code brief in
 * the workspace-write sandbox (network only when the brief allows it). Codex reads files through its shell
 * tool, so the sandbox is what limits a run; `read` and `shell` add no flags. Approvals are never asked for.
 */
export function codexArgs(brief: Brief, cwd: string, model?: string): string[] {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color=never',
    `--sandbox=${brief.mode === 'plan' ? 'read-only' : 'workspace-write'}`,
    '--config=approval_policy="never"',
  ];
  if (brief.mode === 'code' && brief.allowedActions.includes('network')) args.push('--config=sandbox_workspace_write.network_access=true');
  args.push(`--cd=${cwd}`);
  if (model?.trim()) args.push(`--model=${model.trim()}`);
  args.push('--', briefPrompt(brief));
  return args;
}

/** What one `exec --json` line means for the run. */
export type CodexLine = {
  events: RunEvent[];
  /** The text of a finished `agent_message` item. */
  message?: string;
  /** Set by `turn.completed` and `turn.failed`. */
  turn?: 'completed' | 'failed';
};

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** "You've hit your usage limit. … Try again at …" is a rate limit; any other message is an error. */
function failure(message: string): RunEvent {
  return detectRateLimit(message) ? { type: 'rate_limit', message } : { type: 'error', message };
}

function toolOf(item: Json): RunEvent | undefined {
  const tool = (name: string, detail: string): RunEvent => ({ type: 'tool', name, ...(detail && { detail }) });
  switch (item.type) {
    case 'command_execution':
      return tool('shell', asString(item.command));
    case 'file_change': {
      const paths = (Array.isArray(item.changes) ? item.changes : []).map((c) => asString(asRecord(c).path)).filter(Boolean);
      return tool('edit', paths.join(', '));
    }
    case 'mcp_tool_call':
      return tool(`${asString(item.server)}.${asString(item.tool)}`, '');
    case 'web_search':
      return tool('web_search', asString(item.query));
    default:
      return undefined;
  }
}

/** Maps one parsed `codex exec --json` line to normalized events. Unknown line and item types yield nothing. */
export function parseCodexLine(json: unknown): CodexLine {
  const line = asRecord(json);
  switch (line.type) {
    case 'item.completed': {
      const item = asRecord(line.item);
      if (item.type === 'agent_message') {
        const text = asString(item.text);
        return text ? { events: [{ type: 'text', text }], message: text } : { events: [] };
      }
      // An `error` item is a warning Codex recovered from; a fatal error arrives as `error` or `turn.failed`.
      if (item.type === 'error') {
        log.debug(`codex warning: ${asString(item.message)}`);
        return { events: [] };
      }
      const tool = toolOf(item);
      return { events: tool ? [tool] : [] };
    }
    case 'turn.completed': {
      const usage = asRecord(line.usage);
      // `input_tokens` already counts the cached ones. Codex reports no cost.
      return { events: [{ type: 'usage', usage: { inputTokens: asNumber(usage.input_tokens), outputTokens: asNumber(usage.output_tokens) } }], turn: 'completed' };
    }
    case 'turn.failed': {
      const message = asString(asRecord(line.error).message) || 'Codex turn failed';
      return { events: [failure(message)], turn: 'failed' };
    }
    case 'error':
      return { events: [failure(asString(line.message) || 'Codex stream error')] };
    default:
      return { events: [] };
  }
}

/** Runs one brief through `codex exec --json` under the user's own Codex login and streams normalized events. */
export async function* runCodex(input: {
  command: string;
  env: NodeJS.ProcessEnv;
  brief: Brief;
  opts: DriverRunOptions;
}): AsyncGenerator<NormalizedEvent> {
  const { command, env, brief, opts } = input;
  const startedAt = Date.now();
  const streamed: RunEvent[] = [];
  let finalText: string | undefined;
  let turn: CodexLine['turn'];
  let status: ReportStatus = 'ok';

  const rateLimited = () => streamed.some((e) => e.type === 'rate_limit');
  const emit = (event: RunEvent) => {
    streamed.push(event);
    return event;
  };
  // Codex sends a fatal error twice (`error`, then `turn.failed`), and a limit may also reach stderr; the first is enough.
  const isRepeat = (event: RunEvent) =>
    (event.type === 'rate_limit' && rateLimited()) || (event.type === 'error' && streamed.some((e) => e.type === 'error' && e.message === event.message));

  const args = codexArgs(brief, opts.cwd, opts.model);
  for await (const item of streamSubprocess({ command, args, cwd: opts.cwd, env, timeoutMs: opts.timeoutMs, signal: opts.signal })) {
    if (item.kind === 'line') {
      if (item.stream === 'stderr') {
        if (item.rateLimit && !rateLimited()) yield emit({ type: 'rate_limit', ...item.rateLimit });
        continue;
      }
      if (item.json === undefined) {
        if (item.text.trim()) log.debug(`ignoring non-JSON stdout line: ${item.text.slice(0, 200)}`);
        continue;
      }
      const parsed = parseCodexLine(item.json);
      if (parsed.message !== undefined) finalText = parsed.message;
      if (parsed.turn) turn = parsed.turn;
      for (const event of parsed.events) {
        if (!isRepeat(event)) yield emit(event);
      }
      continue;
    }

    if (item.outcome === 'timeout' || item.outcome === 'aborted') {
      status = item.outcome;
      yield emit({ type: 'error', message: `codex ${item.outcome === 'timeout' ? `timed out after ${opts.timeoutMs}ms` : 'was aborted'}` });
    } else if (item.outcome === 'spawn_error') {
      status = 'error';
      yield emit({ type: 'error', message: `could not start ${command}: ${item.error ?? 'unknown error'}` });
    } else if (rateLimited()) {
      status = 'rate_limited';
    } else if (item.code !== 0 || turn !== 'completed') {
      status = 'error';
      if (!streamed.some((e) => e.type === 'error')) {
        const stderr = item.stderr.filter((l) => l.trim()).slice(-5).join('\n');
        const why = item.code !== 0 ? `codex exited with code ${item.code}` : 'codex exited without finishing the turn';
        yield emit({ type: 'error', message: stderr ? `${why}: ${stderr}` : why });
      }
    }
  }

  yield {
    type: 'done',
    report: buildReport({
      driverId: 'codex',
      model: opts.model?.trim() || null,
      status,
      events: streamed,
      durationMs: Date.now() - startedAt,
      // Codex may send interim messages between tool calls; the answer is the last one.
      finalText: status === 'ok' ? (finalText ?? '') : '',
    }),
  };
}
