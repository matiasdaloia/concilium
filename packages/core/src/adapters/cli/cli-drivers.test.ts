/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setLogLevel } from '../../shared/logger.js';
import {
  createHeadlessCliDrivers,
  geminiAuthFromEnv,
  parseClaudeAuthStatus,
  parseCodexLoginStatus,
  parseOpenCodeAuthList,
  parseVersion,
} from './cli-drivers.js';

// Status outputs below are written from the CLIs' documented formats, not recorded from a real run.
const ok = (stdout: string, stderr = '') => ({ code: 0, stdout, stderr });

describe('status parsers', () => {
  it('should read the version out of each CLI style', () => {
    expect(parseVersion('2.1.3 (Claude Code)')).toBe('2.1.3');
    expect(parseVersion('codex-cli 0.98.0')).toBe('0.98.0');
    expect(parseVersion('0.12.0-preview.1\n')).toBe('0.12.0-preview.1');
    expect(parseVersion('dev build')).toBe('dev build');
    expect(parseVersion('')).toBeUndefined();
  });

  it('should read claude auth status JSON', () => {
    expect(parseClaudeAuthStatus(ok('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'))).toEqual({
      auth: 'subscription',
      notes: 'plan: max',
    });
    expect(parseClaudeAuthStatus(ok('{"loggedIn":true,"authMethod":"api_key"}'))).toEqual({ auth: 'api-key' });
    expect(parseClaudeAuthStatus({ code: 1, stdout: '{"loggedIn":false}', stderr: '' }).auth).toBe('none');
    expect(parseClaudeAuthStatus(ok('Usage: claude [options]')).auth).toBe('unknown');
  });

  it('should read codex login status from either stream', () => {
    expect(parseCodexLoginStatus(ok('', 'Logged in using ChatGPT')).auth).toBe('subscription');
    expect(parseCodexLoginStatus(ok('Logged in using an API key - sk-proj-***abc')).auth).toBe('api-key');
    expect(parseCodexLoginStatus({ code: 1, stdout: '', stderr: 'Not logged in' }).auth).toBe('none');
  });

  it('should read opencode auth list and flag a Claude subscription inside OpenCode', () => {
    const list = '┌  Credentials ~/.local/share/opencode/auth.json\n│\n\x1B[2m●\x1B[0m  Anthropic oauth\n│\n●  OpenAI api\n│\n└  2 credentials';
    expect(parseOpenCodeAuthList(ok(list))).toEqual({
      auth: 'subscription',
      notes: 'oauth: Anthropic',
      warning: 'Anthropic terms do not cover Claude subscription login in OpenCode',
    });
    expect(parseOpenCodeAuthList(ok('●  OpenAI oauth\n└  1 credentials'))).toEqual({ auth: 'subscription', notes: 'oauth: OpenAI' });
    expect(parseOpenCodeAuthList(ok('●  OpenAI api\n└  1 credentials')).auth).toBe('api-key');
    expect(parseOpenCodeAuthList(ok('┌  Credentials\n└  0 credentials')).auth).toBe('none');
  });

  it('should only check that Gemini API key variables are set', () => {
    expect(geminiAuthFromEnv({ GEMINI_API_KEY: 'x' }).auth).toBe('api-key');
    expect(geminiAuthFromEnv({}).auth).toBe('unknown');
  });
});

describe('detect (fake CLIs on PATH)', () => {
  let binDir: string;

  beforeAll(() => setLogLevel('error'));

  async function fakeCli(name: string, outputs: Record<string, { stdout?: string; stderr?: string; code?: number }>) {
    const script = `#!${process.execPath}
const out = ${JSON.stringify(outputs)}[process.argv.slice(2).join(' ')] ?? { stderr: 'unknown command', code: 2 };
if (out.stdout) process.stdout.write(out.stdout + '\\n');
if (out.stderr) process.stderr.write(out.stderr + '\\n');
process.exitCode = out.code ?? 0;
`;
    await writeFile(join(binDir, name), script);
    await chmod(join(binDir, name), 0o755);
  }

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'concilium-fake-clis-'));
  });

  afterEach(async () => {
    await rm(binDir, { recursive: true, force: true });
  });

  it('should report version and auth for installed CLIs and not-installed for the rest', async () => {
    await fakeCli('claude', {
      '--version': { stdout: '2.1.3 (Claude Code)' },
      'auth status': { stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}' },
    });
    await fakeCli('codex', { '--version': { stdout: 'codex-cli 0.98.0' }, 'login status': { stderr: 'Not logged in', code: 1 } });
    await fakeCli('gemini', { '--version': { stdout: '0.9.0' } });

    const drivers = createHeadlessCliDrivers({ PATH: binDir });
    const detected = await Promise.all(drivers.map(async (d) => [d.id, await d.detect()]));

    expect(Object.fromEntries(detected)).toEqual({
      claude: { installed: true, version: '2.1.3', auth: 'subscription', notes: 'plan: pro' },
      codex: { installed: true, version: '0.98.0', auth: 'none', notes: 'not logged in: run `codex login`' },
      gemini: {
        installed: true,
        version: '0.9.0',
        auth: 'unknown',
        notes: 'no auth status command; a Google sign-in is checked on first run',
      },
      opencode: { installed: false },
    });
  });

  it('should list the models `opencode models` prints and none for CLIs without a model list', async () => {
    await fakeCli('opencode', { models: { stdout: '\x1B[1manthropic/claude-sonnet-4-5\x1B[0m\nopenai/gpt-5.2\n\nnot a model id' } });

    const drivers = new Map(createHeadlessCliDrivers({ PATH: binDir }).map((d) => [d.id, d]));

    expect(await drivers.get('opencode')!.listModels()).toEqual(['anthropic/claude-sonnet-4-5', 'openai/gpt-5.2']);
    expect(await drivers.get('claude')!.listModels()).toEqual([]);
  });

  it('should fail to list models when `opencode models` fails', async () => {
    await fakeCli('opencode', { models: { stderr: 'boom', code: 1 } });

    const opencode = createHeadlessCliDrivers({ PATH: binDir }).find((d) => d.id === 'opencode')!;

    await expect(opencode.listModels()).rejects.toThrow('`opencode models` exited with code 1');
  });
});
