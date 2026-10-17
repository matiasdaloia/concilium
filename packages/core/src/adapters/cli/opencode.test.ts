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
import { createHeadlessCliDrivers } from './cli-drivers.js';
import { openCodeArgs, openCodePermission } from './opencode.js';

// NOT RECORDED: the fixtures follow the `run --format json` emitter and the part schemas (StepFinishPart, ToolPart,
// TextPart, APIError) in the installed opencode 1.18.21: one `{ type, timestamp, sessionID, part }` line per
// step_start/tool_use/text/step_finish, and `{ type: 'error', error: { name, data } }` for a session error.
const FIXTURES = join(import.meta.dirname, '__fixtures__');
const PLAN_ANSWER = 'The top-level folders are assets, desktop, docs, packages, scripts and website.';
const QUOTA_MESSAGE = 'You exceeded your current quota, please check your plan and billing details.';

const planBrief: Brief = { version: 1, task: 'List the top-level folders.', mode: 'plan', cwd: '/w', constraints: [], allowedActions: ['read'] };
const codeBrief: Brief = { ...planBrief, mode: 'code', allowedActions: ['read', 'write', 'shell'], constraints: ['Touch only src/'] };

describe('openCodeArgs', () => {
  it('should run a plan brief with the plan agent and never auto-approve', () => {
    const args = openCodeArgs(planBrief);
    expect(args).toEqual(['run', '--format=json', '--agent=plan', '--', 'List the top-level folders.']);
    expect(args.join(' ')).not.toMatch(/--auto|--yolo|dangerously/);
  });

  it('should run a code brief with the build agent and the given provider/model', () => {
    expect(openCodeArgs(codeBrief, ' openai/gpt-5 ')).toEqual([
      'run',
      '--format=json',
      '--agent=build',
      '--model=openai/gpt-5',
      '--',
      'List the top-level folders.\n\nConstraints:\n- Touch only src/',
    ]);
  });

  it('should run without external plugins only when isolated', () => {
    expect(openCodeArgs(planBrief, undefined, true)).toEqual(['run', '--format=json', '--agent=plan', '--pure', '--', 'List the top-level folders.']);
  });
});

describe('openCodePermission', () => {
  it('should keep a plan brief read-only: no edits and no bash, even when the brief allows shell', () => {
    const permission = openCodePermission({ ...planBrief, allowedActions: ['read', 'shell'] });
    expect(permission).toMatchObject({ edit: 'deny', bash: 'deny', webfetch: 'deny', question: 'deny', plan_exit: 'deny' });
    expect(permission).not.toHaveProperty('read');
  });

  it('should deny only the tools of actions a code brief does not allow', () => {
    const permission = openCodePermission(codeBrief);
    expect(permission).toMatchObject({ webfetch: 'deny', websearch: 'deny', question: 'deny' });
    for (const key of ['read', 'edit', 'bash']) expect(permission).not.toHaveProperty(key);
  });
});

describe('OpenCode driver run (fake opencode on PATH)', () => {
  let tmp: string;
  let binDir: string;

  beforeAll(() => setLogLevel('error'));

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'concilium-opencode-'));
    binDir = join(tmp, 'bin');
    await mkdir(binDir);
    // Appends its argv, cwd and OPENCODE_PERMISSION to calls.jsonl, replays FAKE_FIXTURE, then exits or hangs as told.
    const script = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(tmp, 'calls.jsonl'))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), permission: process.env.OPENCODE_PERMISSION }) + '\\n');
if (process.env.FAKE_FIXTURE) process.stdout.write(fs.readFileSync(process.env.FAKE_FIXTURE, 'utf8'));
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + '\\n');
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
`;
    await writeFile(join(binDir, 'opencode'), script, { mode: 0o755 });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function run(env: Record<string, string>, opts: { timeoutMs?: number; model?: string; path?: string } = {}) {
    const opencode = createHeadlessCliDrivers({ PATH: opts.path ?? binDir, ...env }).find((d) => d.id === 'opencode')!;
    const events: NormalizedEvent[] = [];
    const run = opencode.run(
      { ...planBrief, cwd: tmp },
      { cwd: tmp, timeoutMs: opts.timeoutMs ?? 10_000, signal: new AbortController().signal, ...(opts.model && { model: opts.model }) },
    );
    for await (const event of run) events.push(event);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('run did not end with done');
    return { events: events.slice(0, -1), report: parseReport(done.report) };
  }

  async function calls(): Promise<{ argv: string[]; cwd: string; permission: string }[]> {
    return (await readFile(join(tmp, 'calls.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; cwd: string; permission: string });
  }

  async function writeLines(name: string, lines: unknown[]): Promise<string> {
    const file = join(tmp, name);
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }

  it('should stream tool, usage and text events and end with an ok report holding the answer', async () => {
    const { events, report } = await run({ FAKE_FIXTURE: join(FIXTURES, 'opencode-run-plan.jsonl') }, { model: 'openai/gpt-5' });

    expect(events).toEqual([
      { type: 'tool', name: 'glob', detail: '*' },
      { type: 'tool', name: 'read', detail: '/w/AGENTS.md' },
      { type: 'usage', usage: { inputTokens: 12410, outputTokens: 134, costUsd: 0.0123 } },
      { type: 'text', text: PLAN_ANSWER },
      { type: 'usage', usage: { inputTokens: 12760, outputTokens: 163, costUsd: 0.0045 } },
    ]);
    expect(report).toMatchObject({ driverId: 'opencode', model: 'openai/gpt-5', status: 'ok', finalText: PLAN_ANSWER, errors: [] });
    expect(report.usage).toEqual({ inputTokens: 25170, outputTokens: 297, costUsd: 0.0168 });

    const [call] = await calls();
    expect(call.cwd).toBe(tmp);
    expect(call.argv).toEqual(openCodeArgs(planBrief, 'openai/gpt-5'));
    expect(JSON.parse(call.permission)).toEqual(openCodePermission(planBrief));
  });

  it('should report an error with the stderr tail when opencode exits non-zero', async () => {
    const { events, report } = await run({ FAKE_STDERR: '\x1B[91m\x1B[1mError: \x1B[0mModel not found: openai/gpt-9', FAKE_EXIT: '1' });

    expect(events).toEqual([{ type: 'error', message: 'opencode exited with code 1: Error: Model not found: openai/gpt-9' }]);
    expect(report.status).toBe('error');
    expect(report.finalText).toBe('');
  });

  it('should report a session error line as an error and drop the partial answer', async () => {
    const fixture = await writeLines('failed.jsonl', [
      { type: 'text', timestamp: 1, sessionID: 's', part: { type: 'text', text: 'Partial', time: { start: 0, end: 1 } } },
      { type: 'error', timestamp: 2, sessionID: 's', error: { name: 'ProviderAuthError', data: { providerID: 'openai', message: 'Invalid API key' } } },
    ]);
    const { events, report } = await run({ FAKE_FIXTURE: fixture, FAKE_EXIT: '1' });

    expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'Invalid API key' }]);
    expect(report.status).toBe('error');
    expect(report.finalText).toBe('');
    expect(report.errors).toEqual(['Invalid API key']);
  });

  it('should report a provider 429 as rate_limited with one rate_limit event', async () => {
    const { events, report } = await run({ FAKE_FIXTURE: join(FIXTURES, 'opencode-run-rate-limit.jsonl'), FAKE_EXIT: '1' });

    expect(events).toEqual([{ type: 'rate_limit', message: QUOTA_MESSAGE }]);
    expect(report.status).toBe('rate_limited');
    expect(report.errors).toEqual([QUOTA_MESSAGE]);
  });

  it('should report a rate limit seen only on stderr as rate_limited when the run fails', async () => {
    const { events, report } = await run({ FAKE_STDERR: 'ERROR service=llm error=Rate limit reached for requests', FAKE_EXIT: '1' });

    expect(events.map((e) => e.type)).toEqual(['rate_limit']);
    expect(report.status).toBe('rate_limited');
  });

  it('should skip malformed and non-JSON lines and still finish ok', async () => {
    const lines = (await readFile(join(FIXTURES, 'opencode-run-plan.jsonl'), 'utf8')).trim().split('\n');
    const fixture = join(tmp, 'noisy.jsonl');
    await writeFile(fixture, ['Performing one time database migration...', lines[0], '{"type":"text","part":{"ty', '', ...lines.slice(1)].join('\n') + '\n');
    const { events, report } = await run({ FAKE_FIXTURE: fixture });

    expect(events.map((e) => e.type)).toEqual(['tool', 'tool', 'usage', 'text', 'usage']);
    expect(report.status).toBe('ok');
    expect(report.finalText).toBe(PLAN_ANSWER);
  });

  it('should report an error when opencode exits 0 without finishing a step', async () => {
    const fixture = await writeLines('cut.jsonl', [{ type: 'step_start', timestamp: 1, sessionID: 's', part: { type: 'step-start' } }]);
    const { events, report } = await run({ FAKE_FIXTURE: fixture });

    expect(events).toEqual([{ type: 'error', message: 'opencode exited without finishing a step' }]);
    expect(report.status).toBe('error');
  });

  it('should kill a run that outlives its timeout and report timeout', async () => {
    const started = Date.now();
    const { events, report } = await run({ FAKE_HANG: '1' }, { timeoutMs: 300 });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events).toEqual([{ type: 'error', message: 'opencode timed out after 300ms' }]);
    expect(report.status).toBe('timeout');
  });

  it('should report an error when the opencode binary is missing', async () => {
    const { report } = await run({}, { path: join(tmp, 'empty') });

    expect(report.status).toBe('error');
    expect(report.errors[0]).toMatch(/^could not start opencode/);
  });
});
