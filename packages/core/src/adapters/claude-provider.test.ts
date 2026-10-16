/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../domain/agent/agent-config.js';
import { setLogLevel } from '../shared/logger.js';
import { ClaudeProvider } from './claude-provider.js';

const PLAN_FIXTURE = fileURLToPath(new URL('./parsers/__fixtures__/claude-plan.jsonl', import.meta.url));

/** Stands in for the `claude` CLI: prints a recorded stream to stdout, an optional line to stderr, then exits. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
process.stdout.write(fs.readFileSync(process.env.FAKE_CLAUDE_FIXTURE, 'utf8'));
if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR + '\\n');
process.exitCode = Number(process.env.FAKE_CLAUDE_EXIT || 0);
`;

describe('ClaudeProvider (fake claude binary)', () => {
  let binDir: string;

  beforeAll(() => setLogLevel('error'));

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'concilium-fake-claude-'));
    await writeFile(join(binDir, 'claude'), FAKE_CLAUDE);
    await chmod(join(binDir, 'claude'), 0o755);
    vi.stubEnv('PATH', `${binDir}${delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('FAKE_CLAUDE_FIXTURE', PLAN_FIXTURE);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(binDir, { recursive: true, force: true });
  });

  function agent(): AgentConfig {
    return { id: 'claude', instanceId: 'claude-1', name: 'claude · opus', enabled: true, model: 'opus', cwd: binDir };
  }

  it('should succeed and stream every parsed event to the caller', async () => {
    const streamed: string[] = [];
    const statuses: string[] = [];

    const result = await new ClaudeProvider().execute({
      agent: agent(),
      prompt: 'Add rate limiting',
      callbacks: {
        onStatus: (_key, status) => statuses.push(status),
        onEvent: (key, event) => streamed.push(`${key}:${event.eventType}`),
      },
    });

    expect(result.status).toBe('success');
    expect(statuses).toEqual(['running', 'success']);
    expect(streamed).toContain('claude-1:tool_call');
    expect(result.events.map((e) => `claude-1:${e.eventType}`)).toEqual(streamed);
    expect(result.errors).toEqual([]);
  });

  // With --include-partial-messages the plan arrives as text deltas and again as the `result` text.
  it('should use the final plan text exactly once', async () => {
    const result = await new ClaudeProvider().execute({ agent: agent(), prompt: 'task', callbacks: {} });

    expect(result.normalizedPlan).toBe('## Plan\nAdd middleware.');
  });

  it('should report a non-zero exit as an error and keep raw error lines', async () => {
    vi.stubEnv('FAKE_CLAUDE_EXIT', '1');
    vi.stubEnv('FAKE_CLAUDE_STDERR', '\x1B[31mError: not logged in\x1B[0m');

    const result = await new ClaudeProvider().execute({ agent: agent(), prompt: 'task', callbacks: {} });

    expect(result.status).toBe('error');
    expect(result.errors).toEqual(['\x1B[31mError: not logged in\x1B[0m']);
    expect(result.events).toContainEqual(expect.objectContaining({ eventType: 'raw', text: 'Error: not logged in' }));
  });

  it('should report a missing claude binary as an error', async () => {
    vi.stubEnv('PATH', join(binDir, 'nothing-here'));

    const result = await new ClaudeProvider().execute({ agent: agent(), prompt: 'task', callbacks: {} });

    expect(result.status).toBe('error');
    expect(result.normalizedPlan).toMatch(/^Process error: /);
  });
});
