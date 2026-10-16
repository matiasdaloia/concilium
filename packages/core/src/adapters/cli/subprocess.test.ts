/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setLogLevel } from '../../shared/logger.js';
import { captureSubprocess, streamSubprocess, type SubprocessItem } from './subprocess.js';

/** Stands in for an agent CLI. FAKE_MODE picks what it does; it records its pid so tests can check it died. */
const FAKE_AGENT = `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const mode = process.env.FAKE_MODE;
if (mode === 'stream') {
  // One JSON object split across two writes, a plain line, a blank line, then stderr.
  process.stdout.write('{"type":"text",');
  setTimeout(() => {
    process.stdout.write('"text":"hi"}\\nplain line\\n\\n[1,2]\\n{broken\\n');
    process.stderr.write('warning: something\\nError: 429 Too Many Requests\\n');
    process.exitCode = 3;
  }, 20);
} else if (mode === 'hang') {
  process.on('SIGTERM', () => {}); // ignore SIGTERM so only SIGKILL stops it
  process.stdout.write('{"started":true}\\n');
  setInterval(() => {}, 1000);
}
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

describe('streamSubprocess (fake agent binary)', () => {
  let binDir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => setLogLevel('error'));

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'concilium-fake-agent-'));
    await writeFile(join(binDir, 'fake-agent'), FAKE_AGENT);
    await chmod(join(binDir, 'fake-agent'), 0o755);
    env = { PATH: binDir, FAKE_PID_FILE: join(binDir, 'pid') };
  });

  afterEach(async () => {
    // A failing test must not leave a hung fake behind.
    const pid = await fakePid().catch(() => NaN);
    if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
    await rm(binDir, { recursive: true, force: true });
  });

  async function collect(items: AsyncIterable<SubprocessItem>): Promise<SubprocessItem[]> {
    const all: SubprocessItem[] = [];
    for await (const item of items) all.push(item);
    return all;
  }

  async function fakePid(): Promise<number> {
    return Number(await readFile(join(binDir, 'pid'), 'utf8'));
  }

  it('should yield stdout lines with parsed JSON, stderr lines, rate-limit flags, then the exit', async () => {
    const items = await collect(
      streamSubprocess({ command: 'fake-agent', args: [], env: { ...env, FAKE_MODE: 'stream' }, timeoutMs: 5000 }),
    );

    const stdout = items.filter((i) => i.kind === 'line' && i.stream === 'stdout');
    expect(stdout).toEqual([
      { kind: 'line', stream: 'stdout', text: '{"type":"text","text":"hi"}', json: { type: 'text', text: 'hi' } },
      { kind: 'line', stream: 'stdout', text: 'plain line' },
      { kind: 'line', stream: 'stdout', text: '' },
      { kind: 'line', stream: 'stdout', text: '[1,2]', json: [1, 2] },
      { kind: 'line', stream: 'stdout', text: '{broken' },
    ]);
    expect(items).toContainEqual({
      kind: 'line',
      stream: 'stderr',
      text: 'Error: 429 Too Many Requests',
      rateLimit: { message: 'Error: 429 Too Many Requests' },
    });
    expect(items.at(-1)).toEqual({
      kind: 'exit',
      outcome: 'exited',
      code: 3,
      signal: null,
      stderr: ['warning: something', 'Error: 429 Too Many Requests'],
    });
    expect(items.filter((i) => i.kind === 'exit')).toHaveLength(1);
  });

  it('should kill the process group on timeout and report it', async () => {
    const items = await collect(
      streamSubprocess({ command: 'fake-agent', args: [], env: { ...env, FAKE_MODE: 'hang' }, timeoutMs: 300, killGraceMs: 100 }),
    );

    expect(items[0]).toMatchObject({ kind: 'line', json: { started: true } });
    expect(items.at(-1)).toMatchObject({ kind: 'exit', outcome: 'timeout', signal: 'SIGKILL' });
    expect(await waitForDeath(await fakePid())).toBe(true);
  });

  it('should kill the process when the signal aborts', async () => {
    const controller = new AbortController();
    const items: SubprocessItem[] = [];
    for await (const item of streamSubprocess({
      command: 'fake-agent',
      args: [],
      env: { ...env, FAKE_MODE: 'hang' },
      timeoutMs: 10_000,
      killGraceMs: 100,
      signal: controller.signal,
    })) {
      items.push(item);
      if (item.kind === 'line') controller.abort();
    }

    expect(items.at(-1)).toMatchObject({ kind: 'exit', outcome: 'aborted' });
    expect(await waitForDeath(await fakePid())).toBe(true);
  });

  it('should kill the process when the caller stops reading early', async () => {
    for await (const item of streamSubprocess({
      command: 'fake-agent',
      args: [],
      env: { ...env, FAKE_MODE: 'hang' },
      timeoutMs: 10_000,
      killGraceMs: 100,
    })) {
      if (item.kind === 'line') break;
    }

    expect(await waitForDeath(await fakePid())).toBe(true);
  });

  it('should report a missing binary as a spawn error', async () => {
    const result = await captureSubprocess({ command: 'no-such-agent', args: [], env, timeoutMs: 5000 });

    expect(result.outcome).toBe('spawn_error');
    expect(result.error).toMatch(/ENOENT/);
  });

  it('should use a custom rate-limit detector', async () => {
    const items = await collect(
      streamSubprocess({
        command: 'fake-agent',
        args: [],
        env: { ...env, FAKE_MODE: 'stream' },
        timeoutMs: 5000,
        detectRateLimit: (line) => (line === 'plain line' ? { message: 'custom', retryAfterMs: 60_000 } : null),
      }),
    );

    const flagged = items.filter((i) => i.kind === 'line' && i.rateLimit);
    expect(flagged).toEqual([
      { kind: 'line', stream: 'stdout', text: 'plain line', rateLimit: { message: 'custom', retryAfterMs: 60_000 } },
    ]);
  });
});
