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
import { codexArgs } from './codex.js';

// The fixtures are written in the `codex exec --json` event format (thread/turn/item events), not recorded.
const FIXTURES = join(import.meta.dirname, '__fixtures__');
const PLAN_ANSWER = 'The top-level folders are assets, desktop, docs, packages, scripts and website.';
const LIMIT_MESSAGE =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 17th, 2026 9:00 AM.";

const planBrief: Brief = { version: 1, task: 'List the top-level folders.', mode: 'plan', cwd: '/w', constraints: [], allowedActions: ['read'] };

describe('codexArgs', () => {
  it('should run a plan brief in the read-only sandbox without approvals', () => {
    const args = codexArgs(planBrief, '/w');
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--ephemeral']);
    expect(args).toContain('--sandbox=read-only');
    expect(args).toContain('--config=approval_policy="never"');
    expect(args).toContain('--cd=/w');
    expect(args.join(' ')).not.toMatch(/workspace-write|network_access|--model|dangerously/);
    expect(args.slice(-2)).toEqual(['--', 'List the top-level folders.']);
  });

  it('should run a code brief in the workspace-write sandbox, with network only when allowed', () => {
    const code: Brief = { ...planBrief, mode: 'code', allowedActions: ['read', 'write', 'shell'], constraints: ['Touch only src/'] };
    const args = codexArgs(code, '/w', ' gpt-5-codex ');
    expect(args).toContain('--sandbox=workspace-write');
    expect(args.join(' ')).not.toMatch(/network_access/);
    expect(args).toContain('--model=gpt-5-codex');
    expect(args.at(-1)).toBe('List the top-level folders.\n\nConstraints:\n- Touch only src/');

    expect(codexArgs({ ...code, allowedActions: ['read', 'write', 'network'] }, '/w')).toContain('--config=sandbox_workspace_write.network_access=true');
  });

  it("should skip the user's config.toml, hooks and plugins only when isolated, still in the read-only sandbox", () => {
    expect(codexArgs(planBrief, '/w').join(' ')).not.toMatch(/ignore-user-config|--disable/);
    const args = codexArgs(planBrief, '/w', undefined, true);
    expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--disable=hooks', '--disable=plugins', '--sandbox=read-only']));
    expect(args.slice(-2)).toEqual(['--', 'List the top-level folders.']);
  });
});

describe('Codex driver run (fake codex on PATH)', () => {
  let tmp: string;
  let binDir: string;

  beforeAll(() => setLogLevel('error'));

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'concilium-codex-'));
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
    await writeFile(join(binDir, 'codex'), script, { mode: 0o755 });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function run(env: Record<string, string>, opts: { timeoutMs?: number; model?: string; path?: string } = {}) {
    const codex = createHeadlessCliDrivers({ PATH: opts.path ?? binDir, ...env }).find((d) => d.id === 'codex')!;
    const events: NormalizedEvent[] = [];
    const run = codex.run(
      { ...planBrief, cwd: tmp },
      { cwd: tmp, timeoutMs: opts.timeoutMs ?? 10_000, signal: new AbortController().signal, ...(opts.model && { model: opts.model }) },
    );
    for await (const event of run) events.push(event);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('run did not end with done');
    return { events: events.slice(0, -1), report: parseReport(done.report) };
  }

  it('should stream tool, text and usage events and end with an ok report holding the last message', async () => {
    const { events, report } = await run({ FAKE_FIXTURE: join(FIXTURES, 'codex-exec-plan.jsonl') }, { model: 'gpt-5-codex' });

    expect(events).toEqual([
      { type: 'tool', name: 'shell', detail: '/bin/bash -lc ls' },
      { type: 'text', text: 'Let me check for hidden folders too.' },
      { type: 'tool', name: 'shell', detail: "/bin/bash -lc 'ls -d */'" },
      { type: 'text', text: PLAN_ANSWER },
      { type: 'usage', usage: { inputTokens: 24763, outputTokens: 122 } },
    ]);
    expect(report).toMatchObject({ driverId: 'codex', model: 'gpt-5-codex', status: 'ok', finalText: PLAN_ANSWER, errors: [] });
    expect(report.events).toEqual({ text: 2, tool: 2, usage: 1, rate_limit: 0, error: 0 });

    const call = JSON.parse(await readFile(join(tmp, 'call.json'), 'utf8')) as { argv: string[]; cwd: string };
    expect(call.cwd).toBe(tmp);
    expect(call.argv).toEqual(codexArgs({ ...planBrief, cwd: tmp }, tmp, 'gpt-5-codex'));
  });

  it('should name file edits, MCP calls and web searches as tools', async () => {
    const fixture = join(tmp, 'tools.jsonl');
    const items = [
      { id: 'item_0', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }], status: 'completed' },
      { id: 'item_1', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: {}, status: 'completed' },
      { id: 'item_2', type: 'web_search', query: 'codex exec json' },
      { id: 'item_3', type: 'error', message: 'model metadata not found; falling back' },
      { id: 'item_4', type: 'agent_message', text: 'Done.' },
    ];
    const lines = [...items.map((item) => ({ type: 'item.completed', item })), { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }];
    await writeFile(fixture, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { events, report } = await run({ FAKE_FIXTURE: fixture });

    expect(events.filter((e) => e.type === 'tool')).toEqual([
      { type: 'tool', name: 'edit', detail: 'src/a.ts, src/b.ts' },
      { type: 'tool', name: 'docs.search' },
      { type: 'tool', name: 'web_search', detail: 'codex exec json' },
    ]);
    expect(report.status).toBe('ok');
    expect(report.errors).toEqual([]);
  });

  it('should report an error with the stderr tail when codex exits non-zero', async () => {
    const { events, report } = await run({ FAKE_STDERR: 'Error: unexpected argument found', FAKE_EXIT: '2' });

    expect(events).toEqual([{ type: 'error', message: 'codex exited with code 2: Error: unexpected argument found' }]);
    expect(report.status).toBe('error');
    expect(report.finalText).toBe('');
  });

  it('should report a failed turn once as an error and drop the partial answer', async () => {
    const fixture = join(tmp, 'failed.jsonl');
    const message = 'stream disconnected before completion';
    const lines = [
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Partial' } },
      { type: 'error', message },
      { type: 'turn.failed', error: { message } },
    ];
    await writeFile(fixture, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { events, report } = await run({ FAKE_FIXTURE: fixture, FAKE_EXIT: '1' });

    expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message }]);
    expect(report.status).toBe('error');
    expect(report.finalText).toBe('');
    expect(report.errors).toEqual([message]);
  });

  it('should report a usage limit as rate_limited with one rate_limit event', async () => {
    const { events, report } = await run({ FAKE_FIXTURE: join(FIXTURES, 'codex-exec-rate-limit.jsonl'), FAKE_STDERR: 'ERROR: usage limit reached', FAKE_EXIT: '1' });

    expect(events).toEqual([{ type: 'rate_limit', message: LIMIT_MESSAGE }]);
    expect(report.status).toBe('rate_limited');
    expect(report.errors).toEqual([LIMIT_MESSAGE]);
  });

  it('should report a usage limit seen only on stderr as rate_limited', async () => {
    const { events, report } = await run({ FAKE_STDERR: 'ERROR: exceeded retry limit, last status: 429 Too Many Requests', FAKE_EXIT: '1' });

    expect(events.map((e) => e.type)).toEqual(['rate_limit']);
    expect(report.status).toBe('rate_limited');
  });

  it('should skip malformed and non-JSON lines and still finish ok', async () => {
    const lines = (await readFile(join(FIXTURES, 'codex-exec-plan.jsonl'), 'utf8')).trim().split('\n');
    const fixture = join(tmp, 'noisy.jsonl');
    await writeFile(fixture, [lines[0], 'Reading prompt from stdin...', '{"type":"item.completed","item":{"type":"agent_mes', '', ...lines.slice(1)].join('\n') + '\n');
    const { events, report } = await run({ FAKE_FIXTURE: fixture });

    expect(events.map((e) => e.type)).toEqual(['tool', 'text', 'tool', 'text', 'usage']);
    expect(report.status).toBe('ok');
    expect(report.finalText).toBe(PLAN_ANSWER);
  });

  it('should report an error when codex exits 0 without finishing the turn', async () => {
    const fixture = join(tmp, 'cut.jsonl');
    await writeFile(fixture, '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.started"}\n');
    const { events, report } = await run({ FAKE_FIXTURE: fixture });

    expect(events).toEqual([{ type: 'error', message: 'codex exited without finishing the turn' }]);
    expect(report.status).toBe('error');
  });

  it('should kill a run that outlives its timeout and report timeout', async () => {
    const started = Date.now();
    const { events, report } = await run({ FAKE_HANG: '1' }, { timeoutMs: 300 });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events).toEqual([{ type: 'error', message: 'codex timed out after 300ms' }]);
    expect(report.status).toBe('timeout');
  });

  it('should report an error when the codex binary is missing', async () => {
    const { report } = await run({}, { path: join(tmp, 'empty') });

    expect(report.status).toBe('error');
    expect(report.errors[0]).toMatch(/^could not start codex/);
  });
});
