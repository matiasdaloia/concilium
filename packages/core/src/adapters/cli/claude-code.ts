/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { AllowedAction, Brief } from '../../domain/driver/brief.js';
import type { NormalizedEvent, RunEvent } from '../../domain/driver/normalized-event.js';
import { buildReport, type ReportStatus } from '../../domain/driver/report.js';
import type { DriverRunOptions } from '../../ports/headless-cli-driver.js';
import { createLogger } from '../../shared/logger.js';
import { detectRateLimit, streamSubprocess } from './subprocess.js';

const log = createLogger('claude-code');

/** The Claude Code built-in tools each brief action unlocks. Tools of actions the brief does not allow are not available at all. */
const TOOLS_BY_ACTION: Record<AllowedAction, string[]> = {
  read: ['Read', 'Grep', 'Glob'],
  write: ['Edit', 'Write', 'NotebookEdit'],
  shell: ['Bash'],
  network: ['WebFetch', 'WebSearch'],
};

export function claudePrompt(brief: Brief): string {
  if (brief.constraints.length === 0) return brief.task;
  return `${brief.task}\n\nConstraints:\n${brief.constraints.map((c) => `- ${c}`).join('\n')}`;
}

/**
 * `claude -p` arguments for a brief. A plan brief runs in plan mode (read-only). A code brief runs in
 * `dontAsk` mode, where only the tools listed in `--allowedTools` run and anything else is denied.
 */
export function claudeArgs(brief: Brief, model?: string): string[] {
  const tools = brief.allowedActions.flatMap((action) => TOOLS_BY_ACTION[action]);
  const args = [
    '-p',
    '--output-format=stream-json',
    '--verbose',
    '--no-session-persistence',
    `--permission-mode=${brief.mode === 'plan' ? 'plan' : 'dontAsk'}`,
    `--tools=${tools.join(',')}`,
    `--allowedTools=${tools.join(',')}`,
  ];
  if (model?.trim()) args.push(`--model=${model.trim()}`);
  args.push('--', claudePrompt(brief));
  return args;
}

/** What one stream-json line means for the run. `result` is set by the final `result` line only. */
export type ClaudeLine = {
  events: RunEvent[];
  result?: { text: string; isError: boolean };
};

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const isRateLimitText = (text: string): boolean => detectRateLimit(text) !== null || /hit your limit/i.test(text);

function rateLimit(message: string, resetsAtSeconds: number): RunEvent {
  const retryAfterMs = Number.isFinite(resetsAtSeconds) && resetsAtSeconds > 0 ? Math.max(0, resetsAtSeconds * 1000 - Date.now()) : undefined;
  return { type: 'rate_limit', message, ...(retryAfterMs !== undefined && { retryAfterMs }) };
}

function toolDetail(input: Json): string | undefined {
  for (const key of ['file_path', 'path', 'pattern', 'command', 'url', 'query']) {
    if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  }
  return undefined;
}

/** Maps one parsed stream-json line to normalized events. Unknown line types yield nothing. */
export function parseClaudeLine(json: unknown): ClaudeLine {
  const line = asRecord(json);

  // An assistant line with `error` is a synthetic message (e.g. a usage limit); the result line reports it.
  if (line.type === 'assistant' && line.error === undefined) {
    const events: RunEvent[] = [];
    const content = asRecord(line.message).content;
    for (const block of Array.isArray(content) ? content.map(asRecord) : []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) events.push({ type: 'text', text: block.text });
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const detail = toolDetail(asRecord(block.input));
        events.push({ type: 'tool', name: block.name, ...(detail && { detail }) });
      }
    }
    return { events };
  }

  if (line.type === 'rate_limit_event') {
    const info = asRecord(line.rate_limit_info);
    if (info.status !== 'rejected') return { events: [] };
    const kind = typeof info.rateLimitType === 'string' ? ` (${info.rateLimitType})` : '';
    return { events: [rateLimit(`Claude usage limit reached${kind}`, asNumber(info.resetsAt))] };
  }

  if (line.type === 'result') {
    const text = typeof line.result === 'string' ? line.result : '';
    const isError = line.is_error === true || (typeof line.subtype === 'string' && line.subtype !== 'success');
    const usage = asRecord(line.usage);
    // The result line carries the run's cumulative usage, so it is the only usage event.
    const events: RunEvent[] = [
      {
        type: 'usage',
        usage: {
          inputTokens: asNumber(usage.input_tokens) + asNumber(usage.cache_creation_input_tokens) + asNumber(usage.cache_read_input_tokens),
          outputTokens: asNumber(usage.output_tokens),
          ...(typeof line.total_cost_usd === 'number' && { costUsd: line.total_cost_usd }),
        },
      },
    ];
    if (isError) {
      const message = text || `Claude run failed (${String(line.subtype ?? 'error')})`;
      // A usage limit result reads "Claude AI usage limit reached|<reset time in epoch seconds>".
      const [reason, resetsAt] = message.split('|');
      if (isRateLimitText(message)) events.push(rateLimit(reason.trim(), Number(resetsAt)));
      else events.push({ type: 'error', message });
    }
    return { events, result: { text, isError } };
  }

  return { events: [] };
}

/** Runs one brief through `claude -p` under the user's own Claude Code login and streams normalized events. */
export async function* runClaudeCode(input: {
  command: string;
  env: NodeJS.ProcessEnv;
  brief: Brief;
  opts: DriverRunOptions;
}): AsyncGenerator<NormalizedEvent> {
  const { command, env, brief, opts } = input;
  const startedAt = Date.now();
  const streamed: RunEvent[] = [];
  let result: ClaudeLine['result'];
  let status: ReportStatus = 'ok';

  const rateLimited = () => streamed.some((e) => e.type === 'rate_limit');
  const emit = (event: RunEvent) => {
    streamed.push(event);
    return event;
  };

  const items = streamSubprocess({ command, args: claudeArgs(brief, opts.model), cwd: opts.cwd, env, timeoutMs: opts.timeoutMs, signal: opts.signal });
  for await (const item of items) {
    if (item.kind === 'line') {
      if (item.stream === 'stderr') {
        if (item.rateLimit && !rateLimited()) yield emit({ type: 'rate_limit', ...item.rateLimit });
        continue;
      }
      if (item.json === undefined) {
        if (item.text.trim()) log.debug(`ignoring non-JSON stdout line: ${item.text.slice(0, 200)}`);
        continue;
      }
      const parsed = parseClaudeLine(item.json);
      if (parsed.result) result = parsed.result;
      for (const event of parsed.events) {
        // The limit shows up in several lines (rate_limit_event, result, stderr); the first one is enough.
        if (event.type === 'rate_limit' && rateLimited()) continue;
        yield emit(event);
      }
      continue;
    }

    if (item.outcome === 'timeout' || item.outcome === 'aborted') {
      status = item.outcome;
      yield emit({ type: 'error', message: `claude ${item.outcome === 'timeout' ? `timed out after ${opts.timeoutMs}ms` : 'was aborted'}` });
    } else if (item.outcome === 'spawn_error') {
      status = 'error';
      yield emit({ type: 'error', message: `could not start ${command}: ${item.error ?? 'unknown error'}` });
    } else if (rateLimited()) {
      status = 'rate_limited';
    } else if (item.code !== 0 || !result || result.isError) {
      status = 'error';
      if (!streamed.some((e) => e.type === 'error')) {
        const stderr = item.stderr.filter((l) => l.trim()).slice(-5).join('\n');
        const why = item.code !== 0 ? `claude exited with code ${item.code}` : 'claude exited without a result';
        yield emit({ type: 'error', message: stderr ? `${why}: ${stderr}` : why });
      }
    }
  }

  yield {
    type: 'done',
    report: buildReport({
      driverId: 'claude',
      model: opts.model?.trim() || null,
      status,
      events: streamed,
      durationMs: Date.now() - startedAt,
      ...(result && !result.isError && { finalText: result.text }),
    }),
  };
}
