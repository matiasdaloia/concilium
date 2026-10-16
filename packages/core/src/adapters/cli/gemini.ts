/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { briefPrompt, type Brief } from '../../domain/driver/brief.js';
import type { DriverUsage, NormalizedEvent, RunEvent } from '../../domain/driver/normalized-event.js';
import { buildReport, type ReportStatus } from '../../domain/driver/report.js';
import type { DriverRunOptions } from '../../ports/headless-cli-driver.js';
import { createLogger } from '../../shared/logger.js';
import { detectRateLimit, streamSubprocess } from './subprocess.js';

const log = createLogger('gemini');

export type GeminiOutputFormat = 'stream-json' | 'json';

/**
 * `gemini` headless arguments for a brief. Without a TTY, Gemini CLI leaves out every tool that would need
 * approval (shell, file writes, web fetch) unless the approval mode approves it. A plan brief therefore runs in
 * `default` mode, which keeps only the read-only tools; a code brief runs in `auto_edit`, which approves file
 * edits but still leaves out the shell. `yolo` (approve everything) is never used.
 */
export function geminiArgs(brief: Brief, model?: string, format: GeminiOutputFormat = 'stream-json'): string[] {
  const args = [`--output-format=${format}`, `--approval-mode=${brief.mode === 'plan' ? 'default' : 'auto_edit'}`];
  if (model?.trim()) args.push(`--model=${model.trim()}`);
  // `--prompt=` keeps a prompt that starts with `-` from being read as a flag.
  args.push(`--prompt=${briefPrompt(brief)}`);
  return args;
}

/** What one `--output-format stream-json` line means for the run. */
export type GeminiLine = {
  events: RunEvent[];
  /** Set by the `result` line. */
  result?: 'success' | 'error';
};

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});
const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A 429, `RESOURCE_EXHAUSTED` or an exhausted quota is a rate limit; any other message is an error. */
export function isGeminiQuotaError(message: string): boolean {
  return detectRateLimit(message) !== null || /quota|exhausted your capacity/i.test(message);
}

function failure(message: string): RunEvent {
  return isGeminiQuotaError(message) ? { type: 'rate_limit', message } : { type: 'error', message };
}

/** The parameter worth showing for Gemini's built-in tools (`run_shell_command`, `read_file`, `glob`, ...). */
function toolDetail(parameters: Json): string {
  for (const key of ['command', 'file_path', 'absolute_path', 'path', 'dir_path', 'pattern', 'query', 'url']) {
    const value = asString(parameters[key]);
    if (value) return value;
  }
  return '';
}

/** Maps one parsed stream-json line to normalized events. Unknown line types yield nothing. */
export function parseGeminiLine(json: unknown): GeminiLine {
  const line = asRecord(json);
  switch (line.type) {
    case 'message': {
      // The prompt is echoed back as a `user` message; the answer streams as `assistant` deltas.
      const text = asString(line.content);
      return line.role === 'assistant' && text ? { events: [{ type: 'text', text }] } : { events: [] };
    }
    case 'tool_use': {
      const detail = toolDetail(asRecord(line.parameters));
      return { events: [{ type: 'tool', name: asString(line.tool_name) || 'tool', ...(detail && { detail }) }] };
    }
    case 'error': {
      const message = asString(line.message);
      if (line.severity === 'warning') {
        log.debug(`gemini warning: ${message}`);
        return { events: [] };
      }
      return { events: [failure(message || 'Gemini stream error')] };
    }
    case 'result': {
      const stats = asRecord(line.stats);
      const events: RunEvent[] = [];
      if (line.status === 'error') events.push(failure(asString(asRecord(line.error).message) || 'Gemini run failed'));
      if (line.stats !== undefined) events.push({ type: 'usage', usage: { inputTokens: asNumber(stats.input_tokens), outputTokens: asNumber(stats.output_tokens) } });
      return { events, result: line.status === 'success' ? 'success' : 'error' };
    }
    default:
      return { events: [] };
  }
}

/** Maps the single `--output-format json` object (`{ response, stats, error }`) to normalized events. */
export function parseGeminiJsonOutput(json: unknown): GeminiLine {
  const output = asRecord(json);
  const events: RunEvent[] = [];
  const response = asString(output.response);
  if (response) events.push({ type: 'text', text: response });
  const models = Object.values(asRecord(asRecord(output.stats).models));
  if (models.length > 0) {
    const usage: DriverUsage = { inputTokens: 0, outputTokens: 0 };
    for (const model of models) {
      const tokens = asRecord(asRecord(model).tokens);
      usage.inputTokens += asNumber(tokens.prompt);
      usage.outputTokens += asNumber(tokens.candidates);
    }
    events.push({ type: 'usage', usage });
  }
  if (output.error !== undefined && output.error !== null) {
    events.push(failure(asString(asRecord(output.error).message) || 'Gemini run failed'));
    return { events, result: 'error' };
  }
  return { events, result: 'success' };
}

/** Versions older than stream-json reject the flag value before printing anything. */
const REJECTED_STREAM_JSON = /stream-json/;

/** Runs one brief through `gemini` headless mode under the user's own Gemini CLI login and streams normalized events. */
export async function* runGemini(input: {
  command: string;
  env: NodeJS.ProcessEnv;
  brief: Brief;
  opts: DriverRunOptions;
}): AsyncGenerator<NormalizedEvent> {
  const { command, env, brief, opts } = input;
  const startedAt = Date.now();
  const streamed: RunEvent[] = [];
  let result: GeminiLine['result'];
  let status: ReportStatus = 'ok';

  const emit = (event: RunEvent) => {
    streamed.push(event);
    return event;
  };
  // A failure may arrive as an `error` line and again in the `result`; the first is enough.
  const isRepeat = (event: RunEvent) =>
    (event.type === 'rate_limit' || event.type === 'error') && streamed.some((e) => e.type === event.type && e.message === event.message);

  for (const format of ['stream-json', 'json'] as const) {
    const args = geminiArgs(brief, opts.model, format);
    const stdout: string[] = [];
    // Gemini logs retried 429s on stderr; they count only when the run fails in the end.
    let stderrLimit: { message: string } | undefined;
    let retry = false;

    for await (const item of streamSubprocess({ command, args, cwd: opts.cwd, env, timeoutMs: opts.timeoutMs, signal: opts.signal, detectRateLimit: (line) => (isGeminiQuotaError(line) ? { message: line.trim() } : null) })) {
      if (item.kind === 'line') {
        if (item.stream === 'stderr') {
          if (item.rateLimit) stderrLimit = item.rateLimit;
          continue;
        }
        if (format === 'json') {
          stdout.push(item.text);
          continue;
        }
        if (item.json === undefined) {
          if (item.text.trim()) log.debug(`ignoring non-JSON stdout line: ${item.text.slice(0, 200)}`);
          continue;
        }
        const parsed = parseGeminiLine(item.json);
        if (parsed.result) result = parsed.result;
        for (const event of parsed.events) {
          if (!isRepeat(event)) yield emit(event);
        }
        continue;
      }

      if (format === 'json' && item.outcome === 'exited') {
        // The json format prints one object, possibly over several lines, after any startup notices.
        const text = stdout.join('\n');
        const start = text.indexOf('{');
        let parsed: GeminiLine | undefined;
        try {
          parsed = start === -1 ? undefined : parseGeminiJsonOutput(JSON.parse(text.slice(start)));
        } catch {
          log.debug(`could not parse gemini json output: ${text.slice(0, 200)}`);
        }
        if (parsed) {
          result = parsed.result;
          for (const event of parsed.events) yield emit(event);
        }
      }

      const rateLimited = () => streamed.some((e) => e.type === 'rate_limit');
      if (item.outcome === 'timeout' || item.outcome === 'aborted') {
        status = item.outcome;
        yield emit({ type: 'error', message: `gemini ${item.outcome === 'timeout' ? `timed out after ${opts.timeoutMs}ms` : 'was aborted'}` });
      } else if (item.outcome === 'spawn_error') {
        status = 'error';
        yield emit({ type: 'error', message: `could not start ${command}: ${item.error ?? 'unknown error'}` });
      } else if (item.code === 0 && result === 'success') {
        status = 'ok';
      } else if (format === 'stream-json' && streamed.length === 0 && item.code !== 0 && REJECTED_STREAM_JSON.test(item.stderr.join('\n'))) {
        log.debug('gemini rejected --output-format=stream-json; retrying with json');
        retry = true;
      } else if (rateLimited() || (stderrLimit && !streamed.some((e) => e.type === 'error'))) {
        status = 'rate_limited';
        if (!rateLimited() && stderrLimit) yield emit({ type: 'rate_limit', ...stderrLimit });
      } else {
        status = 'error';
        if (!streamed.some((e) => e.type === 'error')) {
          const stderr = item.stderr.filter((l) => l.trim()).slice(-5).join('\n');
          const why = item.code !== 0 ? `gemini exited with code ${item.code}` : 'gemini exited without a result';
          yield emit({ type: 'error', message: stderr ? `${why}: ${stderr}` : why });
        }
      }
    }
    if (!retry) break;
  }

  yield {
    type: 'done',
    report: buildReport({
      driverId: 'gemini',
      model: opts.model?.trim() || null,
      status,
      events: streamed,
      durationMs: Date.now() - startedAt,
      // The answer is every assistant delta joined; a failed run has none.
      ...(status !== 'ok' && { finalText: '' }),
    }),
  };
}
