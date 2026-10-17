/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Brief } from '../../domain/driver/brief.js';
import type { NormalizedEvent } from '../../domain/driver/normalized-event.js';
import { parseReport } from '../../domain/driver/report.js';
import { setLogLevel } from '../../shared/logger.js';
import { claudeArgs } from './claude-code.js';
import { createHeadlessCliDrivers } from './cli-drivers.js';

// The fixtures are written in the documented `claude -p --output-format stream-json --verbose` format, not recorded.
const FIXTURES = join(import.meta.dirname, '__fixtures__');
const PLAN_ANSWER = 'The top-level folders are assets, desktop, docs, packages, scripts and website.';

const planBrief: Brief = { version: 1, task: 'List the top-level folders.', mode: 'plan', cwd: '/w', constraints: [], allowedActions: ['read'] };

describe('claudeArgs', () => {
  it('should run a plan brief read-only in plan mode with only the read tools', () => {
    const args = claudeArgs(planBrief);
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format=stream-json', '--verbose', '--no-session-persistence']);
    expect(args).toContain('--permission-mode=plan');
    expect(args).toContain('--tools=Read,Grep,Glob');
    expect(args).toContain('--allowedTools=Read,Grep,Glob');
    expect(args.join(' ')).not.toMatch(/Edit|Write|Bash|--model/);
    expect(args.slice(-2)).toEqual(['--', 'List the top-level folders.']);
  });

  it('should pre-approve only the tools of the allowed actions for a code brief', () => {
    const args = claudeArgs({ ...planBrief, mode: 'code', allowedActions: ['read', 'write', 'shell'], constraints: ['Touch only src/'] }, ' opus ');
    expect(args).toContain('--permission-mode=dontAsk');
    expect(args).toContain('--tools=Read,Grep,Glob,Edit,Write,NotebookEdit,Bash');
    expect(args).toContain('--allowedTools=Read,Grep,Glob,Edit,Write,NotebookEdit,Bash');
    expect(args.join(' ')).not.toMatch(/WebFetch/);
    expect(args).toContain('--model=opus');
    expect(args.at(-1)).toBe('List the top-level folders.\n\nConstraints:\n- Touch only src/');
  });

  it("should run without the user's customizations only when isolated, keeping the login", () => {
    expect(claudeArgs(planBrief)).not.toContain('--safe-mode');
    const args = claudeArgs(planBrief, undefined, true);
    expect(args).toContain('--safe-mode');
    // --bare would drop the subscription login.
    expect(args).not.toContain('--bare');
    expect(args.slice(-2)).toEqual(['--', 'List the top-level folders.']);
  });
});

describe('ClaudeCode driver run (fake claude on PATH)', () => {
  let tmp: string;
  let binDir: string;

  beforeAll(() => setLogLevel('error'));

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'concilium-claude-code-'));
    binDir = join(tmp, 'bin');
    await mkdir(binDir);
    // Replays FAKE_FIXTURE line by line, records its argv and cwd, then exits or hangs as told.
    const script = `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(tmp, 'call.json'))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
if (process.env.FAKE_FIXTURE) process.stdout.write(fs.readFileSync(process.env.FAKE_FIXTURE, 'utf8'));
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + '\\n');
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
`;
    await writeFile(join(binDir, 'claude'), script, { mode: 0o755 });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function run(env: Record<string, string>, opts: { timeoutMs?: number; model?: string; path?: string } = {}) {
    const claude = createHeadlessCliDrivers({ PATH: opts.path ?? binDir, ...env }).find((d) => d.id === 'claude')!;
    const events: NormalizedEvent[] = [];
    const run = claude.run(
      { ...planBrief, cwd: tmp },
      { cwd: tmp, timeoutMs: opts.timeoutMs ?? 10_000, signal: new AbortController().signal, ...(opts.model && { model: opts.model }) },
    );
    for await (const event of run) events.push(event);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('run did not end with done');
    return { events: events.slice(0, -1), report: parseReport(done.report) };
  }

  it('should stream text, tool and usage events and end with an ok report holding the result text once', async () => {
    const { events, report } = await run({ FAKE_FIXTURE: join(FIXTURES, 'claude-code-plan.jsonl') }, { model: 'sonnet' });

    expect(events).toEqual([
      { type: 'tool', name: 'Glob', detail: '*' },
      { type: 'text', text: PLAN_ANSWER },
      { type: 'usage', usage: { inputTokens: 8 + 1300 + 19200, outputTokens: 62, costUsd: 0.0215 } },
    ]);
    expect(report).toMatchObject({ driverId: 'claude', model: 'sonnet', status: 'ok', finalText: PLAN_ANSWER, errors: [] });
    expect(report.events).toEqual({ text: 1, tool: 1, usage: 1, rate_limit: 0, error: 0 });

    const call = JSON.parse(await readFile(join(tmp, 'call.json'), 'utf8')) as { argv: string[]; cwd: string };
    expect(call.cwd).toBe(tmp);
    expect(call.argv).toEqual(claudeArgs(planBrief, 'sonnet'));
  });

  it('should report an error with the stderr tail when claude exits non-zero', async () => {
    const { events, report } = await run({ FAKE_STDERR: 'Error: Invalid model name', FAKE_EXIT: '1' });

    expect(events).toEqual([{ type: 'error', message: 'claude exited with code 1: Error: Invalid model name' }]);
    expect(report.status).toBe('error');
    expect(report.finalText).toBe('');
  });

  it('should report an error result as an error even when claude exits 0', async () => {
    const fixture = join(tmp, 'error.jsonl');
    await writeFile(fixture, '{"type":"result","subtype":"error_max_turns","is_error":true,"usage":{"input_tokens":1,"output_tokens":2}}\n');
    const { events, report } = await run({ FAKE_FIXTURE: fixture });

    expect(events.at(-1)).toEqual({ type: 'error', message: 'Claude run failed (error_max_turns)' });
    expect(report.status).toBe('error');
    expect(report.errors).toEqual(['Claude run failed (error_max_turns)']);
  });

  it('should report a usage limit as rate_limited with one rate_limit event and a retry delay', async () => {
    const { events, report } = await run({ FAKE_FIXTURE: join(FIXTURES, 'claude-code-rate-limit.jsonl'), FAKE_EXIT: '1' });

    const limits = events.filter((e) => e.type === 'rate_limit');
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ message: 'Claude usage limit reached (five_hour)', retryAfterMs: expect.any(Number) });
    expect(events.some((e) => e.type === 'text')).toBe(false);
    expect(report.status).toBe('rate_limited');
    expect(report.finalText).toBe('');
  });

  it('should read the reset time from a usage limit result without a rate_limit_event', async () => {
    const fixture = join(tmp, 'limit.jsonl');
    await writeFile(fixture, '{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached|4102444800"}\n');
    const { events, report } = await run({ FAKE_FIXTURE: fixture });

    expect(events.find((e) => e.type === 'rate_limit')).toMatchObject({ message: 'Claude AI usage limit reached', retryAfterMs: expect.any(Number) });
    expect(report.status).toBe('rate_limited');
  });

  it('should skip malformed and non-JSON lines and still finish ok', async () => {
    const lines = (await readFile(join(FIXTURES, 'claude-code-plan.jsonl'), 'utf8')).trim().split('\n');
    const fixture = join(tmp, 'noisy.jsonl');
    await writeFile(fixture, [lines[0], 'not json at all', '{"type":"assistant","message":{"content":[{"type":"te', '', ...lines.slice(1)].join('\n') + '\n');
    const { events, report } = await run({ FAKE_FIXTURE: fixture });

    expect(events.map((e) => e.type)).toEqual(['tool', 'text', 'usage']);
    expect(report.status).toBe('ok');
    expect(report.finalText).toBe(PLAN_ANSWER);
  });

  it('should kill a run that outlives its timeout and report timeout', async () => {
    const started = Date.now();
    const { events, report } = await run({ FAKE_HANG: '1' }, { timeoutMs: 300 });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events).toEqual([{ type: 'error', message: 'claude timed out after 300ms' }]);
    expect(report.status).toBe('timeout');
  });

  it('should report an error when the claude binary is missing', async () => {
    const { report } = await run({}, { path: join(tmp, 'empty') });

    expect(report.status).toBe('error');
    expect(report.errors[0]).toMatch(/^could not start claude/);
  });
});
