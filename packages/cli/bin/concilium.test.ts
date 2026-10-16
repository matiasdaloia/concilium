/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '@concilium/core';

const cliRoot = fileURLToPath(new URL('..', import.meta.url));

// Keep the CLI away from the user's real config, data and API keys.
const sandbox = mkdtempSync(join(tmpdir(), 'concilium-cli-test-'));
const sandboxEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: sandbox,
  XDG_CONFIG_HOME: join(sandbox, 'config'),
  XDG_DATA_HOME: join(sandbox, 'data'),
  XDG_CACHE_HOME: join(sandbox, 'cache'),
};

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const binPath = join(cliRoot, 'bin', 'concilium.ts');

// cwd is '/' so the `run --cwd` default printed in help is the same on every machine.
function runCli(...args: string[]): string {
  return execFileSync(process.execPath, ['--import', tsxLoader, binPath, ...args], {
    cwd: '/',
    encoding: 'utf8',
    env: sandboxEnv,
  });
}

describe('concilium bin (from source)', () => {
  it('should list every registered command in --help', () => {
    const help = runCli('--help');
    for (const command of ['run', 'history', 'config', 'models']) {
      expect(help).toMatch(new RegExp(`^\\s+${command}\\b`, 'm'));
    }
  });

  it('should print the package.json version for --version', () => {
    const pkg = JSON.parse(readFileSync(`${cliRoot}package.json`, 'utf8')) as { version: string };
    expect(runCli('--version').trim()).toBe(pkg.version);
  });

  it('should offer every registered provider as a models --agent choice', () => {
    const help = runCli('models', '--help');
    expect(help).toContain(`(${PROVIDER_IDS.join(', ')})`);
  });

  it('should print stable top-level --help output', () => {
    expect(runCli('--help')).toMatchSnapshot();
  });

  it('should print stable run --help output', () => {
    expect(runCli('run', '--help')).toMatchSnapshot();
  });

  it('should keep log lines out of run --json stdout', () => {
    // Empty PATH: no agent binary can start, so the run fails offline after logging.
    const result = spawnSync(process.execPath, ['--import', tsxLoader, binPath, 'run', '--json', '--no-save', '--agents', 'claude,claude', 'task'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...sandboxEnv, PATH: '' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('{"error":"All agents failed');
    expect(result.stdout).toBe('');
  });
});
