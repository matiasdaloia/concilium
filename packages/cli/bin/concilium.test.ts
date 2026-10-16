/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliRoot = fileURLToPath(new URL('..', import.meta.url));

function runCli(...args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', 'bin/concilium.ts', ...args], {
    cwd: cliRoot,
    encoding: 'utf8',
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
    expect(runCli('--version').trim().split('\n').at(-1)).toBe(pkg.version);
  });
});
