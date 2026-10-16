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
import { geminiArgs } from './gemini.js';

// UNVERIFIED: Gemini CLI is not installed here and its docs could not be fetched, so the fixtures follow the
// documented headless format (https://geminicli.com/docs/cli/headless/) from memory: stream-json lines of type
// init/message/tool_use/tool_result/error/result, and the json object `{ response, stats, error }`. They are not
// recorded. Check them against a real `gemini -p ... --output-format stream-json` run.
const FIXTURES = join(import.meta.dirname, '__fixtures__');
const PLAN_ANSWER = 'The top-level folders are assets, desktop, docs, packages, scripts and website.';
const QUOTA_MESSAGE =
  '[API Error: You have exhausted your capacity on this model. Your quota will reset after 7h12m. (Status: RESOURCE_EXHAUSTED, code 429)]';
// What yargs prints when an older Gemini CLI does not know the stream-json format.
const REJECTED = 'Invalid values:\n  Argument: output-format, Given: "stream-json", Choices: "text", "json"';

const planBrief: Brief = { version: 1, task: 'List the top-level folders.', mode: 'plan', cwd: '/w', constraints: [], allowedActions: ['read'] };

describe('geminiArgs', () => {
  it('should run a plan brief in default approval mode, which leaves out every tool that needs approval', () => {
    const args = geminiArgs(planBrief);
    expect(args).toEqual(['--output-format=stream-json', '--approval-mode=default', '--prompt=List the top-level folders.']);
    expect(args.join(' ')).not.toMatch(/yolo|auto_edit|--model/);
  });

  it('should run a code brief in auto_edit mode, never yolo', () => {
    const code: Brief = { ...planBrief, mode: 'code', allowedActions: ['read', 'write', 'shell', 'network'], constraints: ['Touch only src/'] };
    const args = geminiArgs(code, ' gemini-2.5-pro ', 'json');
    expect(args).toEqual([
      '--output-format=json',
      '--approval-mode=auto_edit',
      '--model=gemini-2.5-pro',
      '--prompt=List the top-level folders.\n\nConstraints:\n- Touch only src/',
    ]);
  });
});

describe('Gemini driver run (fake gemini on PATH)', () => {
  let tmp: string;
  let binDir: string;

  beforeAll(() => setLogLevel('error'));

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'concilium-gemini-'));
    binDir = join(tmp, 'bin');
    await mkdir(binDir);
    // Appends its argv and cwd to calls.jsonl, replays FAKE_FIXTURE (or FAKE_JSON_FIXTURE for --output-format=json),
    // then exits or hangs as told. FAKE_REJECT_STREAM_JSON acts like a version without stream-json.
    const script = `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(tmp, 'calls.jsonl'))}, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');
const json = argv.includes('--output-format=json');
if (process.env.FAKE_REJECT_STREAM_JSON && !json) {
  process.stderr.write(${JSON.stringify(REJECTED)} + '\\n');
  process.exit(1);
}
const fixture = json ? process.env.FAKE_JSON_FIXTURE : process.env.FAKE_FIXTURE;
if (fixture) process.stdout.write(fs.readFileSync(fixture, 'utf8'));
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + '\\n');
if (process.env.FAKE_HANG) setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
`;
    await writeFile(join(binDir, 'gemini'), script, { mode: 0o755 });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function run(env: Record<string, string>, opts: { timeoutMs?: number; model?: string; path?: string } = {}) {
    const gemini = createHeadlessCliDrivers({ PATH: opts.path ?? binDir, ...env }).find((d) => d.id === 'gemini')!;
    const events: NormalizedEvent[] = [];
    const run = gemini.run(
      { ...planBrief, cwd: tmp },
      { cwd: tmp, timeoutMs: opts.timeoutMs ?? 10_000, signal: new AbortController().signal, ...(opts.model && { model: opts.model }) },
    );
    for await (const event of run) events.push(event);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('run did not end with done');
    return { events: events.slice(0, -1), report: parseReport(done.report) };
  }

  async function calls(): Promise<{ argv: string[]; cwd: string }[]> {
    return (await readFile(join(tmp, 'calls.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
  }

  async function writeLines(name: string, lines: unknown[]): Promise<string> {
    const file = join(tmp, name);
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }

  it('should stream tool, text and usage events and end with an ok report holding the joined answer', async () => {
    const { events, report } = await run({ FAKE_FIXTURE: join(FIXTURES, 'gemini-stream-json-plan.jsonl') }, { model: 'gemini-2.5-pro' });

    expect(events).toEqual([
      { type: 'tool', name: 'list_directory', detail: '.' },
      { type: 'tool', name: 'read_file', detail: 'AGENTS.md' },
      { type: 'text', text: 'The top-level folders are assets, desktop, docs,' },
      { type: 'text', text: ' packages, scripts and website.' },
      { type: 'usage', usage: { inputTokens: 18210, outputTokens: 243 } },
    ]);
    expect(report).toMatchObject({ driverId: 'gemini', model: 'gemini-2.5-pro', status: 'ok', finalText: PLAN_ANSWER, errors: [] });
    expect(report.events).toEqual({ text: 2, tool: 2, usage: 1, rate_limit: 0, error: 0 });

    const [call] = await calls();
    expect(call.cwd).toBe(tmp);
    expect(call.argv).toEqual(geminiArgs({ ...planBrief, cwd: tmp }, 'gemini-2.5-pro'));
  });

  it('should report an error with the stderr tail when gemini exits non-zero', async () => {
    const { events, report } = await run({ FAKE_STDERR: 'Error when talking to Gemini API: fetch failed', FAKE_EXIT: '1' });

    expect(events).toEqual([{ type: 'error', message: 'gemini exited with code 1: Error when talking to Gemini API: fetch failed' }]);
    expect(report.status).toBe('error');
    expect(report.finalText).toBe('');
  });

  it('should report a failed result once as an error and drop the partial answer', async () => {
    const message = 'Model stream ended with an invalid chunk.';
    const fixture = await writeLines('failed.jsonl', [
      { type: 'message', role: 'assistant', content: 'Partial', delta: true },
      { type: 'error', severity: 'error', message },
      { type: 'result', status: 'error', error: { type: 'Error', message } },
    ]);
    const { events, report } = await run({ FAKE_FIXTURE: fixture, FAKE_EXIT: '1' });

    expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message }]);
    expect(report.status).toBe('error');
    expect(report.finalText).toBe('');
    expect(report.errors).toEqual([message]);
  });

  it('should report RESOURCE_EXHAUSTED as rate_limited with one rate_limit event', async () => {
    const { events, report } = await run({ FAKE_FIXTURE: join(FIXTURES, 'gemini-stream-json-rate-limit.jsonl'), FAKE_EXIT: '1' });

    expect(events.filter((e) => e.type === 'rate_limit')).toEqual([{ type: 'rate_limit', message: QUOTA_MESSAGE }]);
    expect(report.status).toBe('rate_limited');
    expect(report.errors).toEqual([QUOTA_MESSAGE]);
  });

  it('should report a 429 seen only on stderr as rate_limited when the run fails', async () => {
    const stderr = 'Attempt 3 failed with status 429. Retrying with backoff... ApiError: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}';
    const { events, report } = await run({ FAKE_STDERR: stderr, FAKE_EXIT: '1' });

    expect(events.map((e) => e.type)).toEqual(['rate_limit']);
    expect(report.status).toBe('rate_limited');
  });

  it('should stay ok when a retried 429 on stderr is followed by a successful result', async () => {
    const { report } = await run({ FAKE_FIXTURE: join(FIXTURES, 'gemini-stream-json-plan.jsonl'), FAKE_STDERR: 'Attempt 1 failed with status 429. Retrying with backoff...' });

    expect(report.status).toBe('ok');
    expect(report.events.rate_limit).toBe(0);
    expect(report.finalText).toBe(PLAN_ANSWER);
  });

  it('should skip malformed and non-JSON lines and still finish ok', async () => {
    const lines = (await readFile(join(FIXTURES, 'gemini-stream-json-plan.jsonl'), 'utf8')).trim().split('\n');
    const fixture = join(tmp, 'noisy.jsonl');
    await writeFile(fixture, ['Loaded cached credentials.', lines[0], '{"type":"message","role":"assis', '', ...lines.slice(1)].join('\n') + '\n');
    const { events, report } = await run({ FAKE_FIXTURE: fixture });

    expect(events.map((e) => e.type)).toEqual(['tool', 'tool', 'text', 'text', 'usage']);
    expect(report.status).toBe('ok');
    expect(report.finalText).toBe(PLAN_ANSWER);
  });

  it('should report an error when gemini exits 0 without a result', async () => {
    const fixture = await writeLines('cut.jsonl', [{ type: 'init', session_id: 's', model: 'gemini-2.5-pro' }]);
    const { events, report } = await run({ FAKE_FIXTURE: fixture });

    expect(events).toEqual([{ type: 'error', message: 'gemini exited without a result' }]);
    expect(report.status).toBe('error');
  });

  it('should fall back to the json format when the installed gemini rejects stream-json', async () => {
    const output = {
      response: PLAN_ANSWER,
      stats: { models: { 'gemini-2.5-pro': { api: { totalRequests: 2, totalErrors: 0 }, tokens: { prompt: 9000, candidates: 120, total: 9300, cached: 0, thoughts: 180 } } } },
    };
    const fixture = join(tmp, 'output.json');
    await writeFile(fixture, `Loaded cached credentials.\n${JSON.stringify(output, null, 2)}\n`);
    const { events, report } = await run({ FAKE_REJECT_STREAM_JSON: '1', FAKE_JSON_FIXTURE: fixture });

    expect(events).toEqual([
      { type: 'text', text: PLAN_ANSWER },
      { type: 'usage', usage: { inputTokens: 9000, outputTokens: 120 } },
    ]);
    expect(report).toMatchObject({ status: 'ok', finalText: PLAN_ANSWER, errors: [] });
    expect((await calls()).map((c) => c.argv[0])).toEqual(['--output-format=stream-json', '--output-format=json']);
  });

  it('should read a quota error from the json format as rate_limited', async () => {
    const fixture = join(tmp, 'output.json');
    await writeFile(fixture, JSON.stringify({ response: '', error: { type: 'TerminalQuotaError', message: QUOTA_MESSAGE, code: 429 } }, null, 2));
    const { report } = await run({ FAKE_REJECT_STREAM_JSON: '1', FAKE_JSON_FIXTURE: fixture, FAKE_EXIT: '1' });

    expect(report.status).toBe('rate_limited');
    expect(report.errors).toEqual([QUOTA_MESSAGE]);
  });

  it('should kill a run that outlives its timeout and report timeout', async () => {
    const started = Date.now();
    const { events, report } = await run({ FAKE_HANG: '1' }, { timeoutMs: 300 });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events).toEqual([{ type: 'error', message: 'gemini timed out after 300ms' }]);
    expect(report.status).toBe('timeout');
  });

  it('should report an error when the gemini binary is missing', async () => {
    const { report } = await run({}, { path: join(tmp, 'empty') });

    expect(report.status).toBe('error');
    expect(report.errors[0]).toMatch(/^could not start gemini/);
  });
});
