/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('subprocess');

export type RateLimitSignal = { message: string; retryAfterMs?: number };

export type SubprocessSpec = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Wall-clock limit. The process group gets SIGTERM, then SIGKILL after `killGraceMs`. */
  timeoutMs: number;
  signal?: AbortSignal;
  killGraceMs?: number;
  /** Flags a line as a rate-limit message. Defaults to `detectRateLimit`. */
  detectRateLimit?: (line: string) => RateLimitSignal | null;
};

export type SubprocessOutcome = 'exited' | 'timeout' | 'aborted' | 'spawn_error';

export type SubprocessItem =
  | {
      kind: 'line';
      stream: 'stdout' | 'stderr';
      text: string;
      /** The parsed value when a stdout line is a JSON object or array. */
      json?: unknown;
      rateLimit?: RateLimitSignal;
    }
  | {
      kind: 'exit';
      outcome: SubprocessOutcome;
      code: number | null;
      signal: NodeJS.Signals | null;
      /** Every stderr line, in order. */
      stderr: string[];
      error?: string;
    };

const RATE_LIMIT = /rate[ _-]?limit|usage limit|too many requests|\b429\b|quota exceeded|resource[ _]exhausted/i;

export function detectRateLimit(line: string): RateLimitSignal | null {
  return RATE_LIMIT.test(line) ? { message: line.trim() } : null;
}

function parseJsonLine(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Spawns a command and yields its output line by line, then exactly one `exit` item.
 * The process runs in its own process group so a timeout, an abort, or the caller
 * leaving the loop early kills it and everything it started.
 */
export async function* streamSubprocess(spec: SubprocessSpec): AsyncGenerator<SubprocessItem> {
  const queue: SubprocessItem[] = [];
  let wake: (() => void) | null = null;
  const push = (item: SubprocessItem) => {
    queue.push(item);
    wake?.();
  };

  const detect = spec.detectRateLimit ?? detectRateLimit;
  const stderr: string[] = [];
  let outcome: SubprocessOutcome = 'exited';
  let finished = false;
  let killTimer: NodeJS.Timeout | undefined;

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  const kill = (reason: SubprocessOutcome) => {
    if (finished || child.pid === undefined) return;
    if (outcome === 'exited') outcome = reason;
    const pid = child.pid;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        // The group is already gone.
      }
    };
    signalGroup('SIGTERM');
    killTimer ??= setTimeout(() => signalGroup('SIGKILL'), spec.killGraceMs ?? 2000).unref();
  };

  const timeout = setTimeout(() => kill('timeout'), spec.timeoutMs);
  const onAbort = () => kill('aborted');
  if (spec.signal?.aborted) onAbort();
  spec.signal?.addEventListener('abort', onAbort, { once: true });

  const readLines = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr') =>
    new Promise<void>((resolve) => {
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (text) => {
        if (name === 'stderr') stderr.push(text);
        const json = name === 'stdout' ? parseJsonLine(text) : undefined;
        const rateLimit = detect(text) ?? undefined;
        push({ kind: 'line', stream: name, text, ...(json !== undefined && { json }), ...(rateLimit && { rateLimit }) });
      });
      rl.on('close', resolve);
    });

  const linesDone = Promise.all([readLines(child.stdout, 'stdout'), readLines(child.stderr, 'stderr')]);

  child.on('error', (err) => {
    log.debug(`${spec.command}: spawn error: ${err.message}`);
    finished = true;
    push({ kind: 'exit', outcome: 'spawn_error', code: null, signal: null, stderr, error: err.message });
  });
  child.on('close', (code, signal) => {
    clearTimeout(killTimer);
    if (finished) return;
    void linesDone.then(() => {
      finished = true;
      push({ kind: 'exit', outcome, code, signal, stderr });
    });
  });

  try {
    while (true) {
      const item = queue.shift();
      if (!item) {
        await new Promise<void>((resolve) => {
          wake = () => resolve();
        });
        wake = null;
        continue;
      }
      yield item;
      if (item.kind === 'exit') return;
    }
  } finally {
    clearTimeout(timeout);
    spec.signal?.removeEventListener('abort', onAbort);
    if (!finished) kill('aborted');
  }
}

/** Runs a short command to completion and returns its output, e.g. `--version` or a status command. */
export async function captureSubprocess(
  spec: SubprocessSpec,
): Promise<{ outcome: SubprocessOutcome; code: number | null; stdout: string; stderr: string; error?: string }> {
  const stdout: string[] = [];
  for await (const item of streamSubprocess(spec)) {
    if (item.kind === 'line' && item.stream === 'stdout') stdout.push(item.text);
    if (item.kind === 'exit') {
      return { outcome: item.outcome, code: item.code, stdout: stdout.join('\n'), stderr: item.stderr.join('\n'), error: item.error };
    }
  }
  throw new Error('unreachable: streamSubprocess always ends with an exit item');
}
