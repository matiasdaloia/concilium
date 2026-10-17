/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Brief } from '../../domain/driver/brief.js';
import { setLogLevel } from '../../shared/logger.js';
import { PUSH_CREDENTIAL_VARS, withoutPushCredentials } from './agent-env.js';
import { createHeadlessCliDrivers } from './cli-drivers.js';

const CREDENTIALS = Object.fromEntries(PUSH_CREDENTIAL_VARS.map((name) => [name, `secret-${name}`]));

describe('withoutPushCredentials', () => {
  it('should drop push credentials, reset the credential helpers and keep everything else', () => {
    const env = withoutPushCredentials({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', ...CREDENTIALS });

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      ANTHROPIC_API_KEY: 'k',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    });
  });

  it('should append to command-scope config the caller already set', () => {
    const env = withoutPushCredentials({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });

    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '' });
  });

  it('should keep git from reading a credential a configured helper stored', async () => {
    const home = await mkdtemp(join(tmpdir(), 'concilium-agent-env-'));
    try {
      const store = join(home, 'git-credentials');
      await writeFile(store, 'https://user:hunter2@forge.example\n');
      await writeFile(join(home, 'gitconfig'), `[credential]\n\thelper = store --file ${store}\n`);
      const base = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
      const fill = (env: NodeJS.ProcessEnv) =>
        spawnSync('git', ['credential', 'fill'], { cwd: home, env, input: 'protocol=https\nhost=forge.example\n\n', encoding: 'utf8' });

      expect(fill(base).stdout).toContain('password=hunter2');
      const scrubbed = fill(withoutPushCredentials(base));
      expect(scrubbed.stdout).not.toContain('hunter2');
      expect(scrubbed.status).not.toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('agent CLI runs (fake CLIs on PATH)', () => {
  let dir: string;

  beforeAll(() => setLogLevel('error'));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'concilium-agent-env-run-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('should start every agent CLI without push credentials', async () => {
    for (const name of ['claude', 'codex', 'gemini', 'opencode']) {
      await writeFile(
        join(dir, name),
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(dir, `${name}.env.json`))}, JSON.stringify(process.env));\n`,
      );
      await chmod(join(dir, name), 0o755);
    }
    const brief: Brief = { version: 1, task: 'write code', mode: 'code', cwd: dir, constraints: [], allowedActions: ['read', 'write', 'shell'] };

    for (const driver of createHeadlessCliDrivers({ PATH: dir, ...CREDENTIALS })) {
      for await (const event of driver.run(brief, { cwd: dir, timeoutMs: 10_000, signal: new AbortController().signal })) void event;
      const env = JSON.parse(await readFile(join(dir, `${driver.id}.env.json`), 'utf8')) as Record<string, string>;

      for (const name of PUSH_CREDENTIAL_VARS) expect(env[name], `${driver.id} ${name}`).toBeUndefined();
      expect(env).toMatchObject({ PATH: dir, GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_TERMINAL_PROMPT: '0' });
    }
  });
});
