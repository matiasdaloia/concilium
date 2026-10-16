/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PROVIDER_IDS, type RunRecord } from '@concilium/core';

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

/**
 * A fake agent CLI as a Node script. Its shebang names node directly, so PATH can hold only the fake CLIs.
 * It answers `--version` and the auth status commands as signed in. A run logs its argv to `argvLog`, then prints,
 * in the CLI's own JSON stream format: a plan as an agent, `Response A > B > C` as a juror, or a synthesis as the
 * chairman. Juror and chairman briefs point at `council-prompt.md` in the run's cwd.
 */
function fakeAgentCli(cli: string, argvLog: string): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const cli = ${JSON.stringify(cli)};
const argv = process.argv.slice(2);
const args = argv.join(' ');
if (args === '--version') { console.log('1.0.0'); process.exit(0); }
if (args === 'auth status') { console.log('{"loggedIn":true,"authMethod":"claude.ai"}'); process.exit(0); }
if (args === 'login status') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (args === 'auth list') { console.log('●  Anthropic oauth'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ cli, argv }) + '\\n');
let text = 'Plan from ' + cli;
if (args.includes('council-prompt.md')) {
  const prompt = fs.readFileSync('council-prompt.md', 'utf8');
  text = prompt.includes('provide your code review and ranking')
    ? 'FINAL RANKING:\\n1. Response A\\n2. Response B\\n3. Response C'
    : 'Synthesis from ' + cli;
}
const usage = { input_tokens: 10, output_tokens: 5 };
const lines = {
  claude: [{ type: 'result', subtype: 'success', is_error: false, result: text, usage }],
  codex: [{ type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed', usage }],
  gemini: [{ type: 'message', role: 'assistant', content: text, delta: true }, { type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 5 } }],
}[cli];
for (const line of lines) console.log(JSON.stringify(line));
`;
}

describe('concilium bin (from source)', () => {
  it('should list every registered command in --help', () => {
    const help = runCli('--help');
    for (const command of ['run', 'history', 'config', 'models', 'doctor', 'gc', 'trail', 'gates', 'approve', 'reject']) {
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

  it('should print stable code --help output', () => {
    expect(runCli('code', '--help')).toMatchSnapshot();
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

  it('should complete all three stages on claude, codex and gemini with no API key', () => {
    const binDir = join(sandbox, 'council-bin');
    const argvLog = join(sandbox, 'council-argv.jsonl');
    mkdirSync(binDir, { recursive: true });
    for (const cli of ['claude', 'codex', 'gemini']) {
      writeFileSync(join(binDir, cli), fakeAgentCli(cli, argvLog), { mode: 0o755 });
    }

    // PATH holds only the fake CLIs; the env has no OPENROUTER_API_KEY and HOME is the sandbox.
    const result = spawnSync(
      process.execPath,
      ['--import', tsxLoader, binPath, 'run', '--json', '--no-save', '--agents', 'claude,codex,gemini', 'Add rate limiting'],
      { cwd: sandbox, encoding: 'utf8', env: { ...sandboxEnv, PATH: binDir } },
    );

    expect(result.stderr).not.toContain('"error"');
    expect(result.status).toBe(0);
    const record = JSON.parse(result.stdout) as RunRecord;
    expect(record.stage1).toEqual([
      { model: 'claude', response: 'Plan from claude' },
      { model: 'codex', response: 'Plan from codex' },
      { model: 'gemini', response: 'Plan from gemini' },
    ]);
    expect(record.stage2.map((r) => r.model)).toEqual(['claude', 'codex', 'gemini']);
    expect(record.metadata.aggregateRankings.map((r) => r.model)).toEqual(['claude', 'codex', 'gemini']);
    expect(record.stage3).toMatchObject({ model: 'gemini', response: 'Synthesis from gemini' });
    expect(record.metadata.notes).toBeUndefined();

    // 3 agents + 3 jurors + 1 chairman, every one in its CLI's read-only mode.
    const runs = readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { cli: string; argv: string[] });
    expect(runs).toHaveLength(7);
    const readOnlyFlag: Record<string, string> = { claude: '--permission-mode=plan', codex: '--sandbox=read-only', gemini: '--approval-mode=default' };
    for (const { cli, argv } of runs) expect(argv).toContain(readOnlyFlag[cli]);
  });

  it('should take the jurors and chairman from the juror and chairman roles of the repo factory.yaml, and exit 1 on an invalid one', () => {
    const binDir = join(sandbox, 'council-bin');
    const argvLog = join(sandbox, 'roles-argv.jsonl');
    mkdirSync(binDir, { recursive: true });
    for (const cli of ['claude', 'codex', 'gemini']) writeFileSync(join(binDir, cli), fakeAgentCli(cli, argvLog), { mode: 0o755 });
    const repo = join(sandbox, 'roles-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.concilium'), { recursive: true });
    const factory = join(repo, '.concilium', 'factory.yaml');
    writeFileSync(factory, 'roles:\n  juror: [claude, codex]\n  chairman: claude\n');
    const run = () => spawnSync(
      process.execPath,
      ['--import', tsxLoader, binPath, 'run', '--json', '--no-save', '--agents', 'claude,codex', '--cwd', repo, 'Add rate limiting'],
      { cwd: sandbox, encoding: 'utf8', env: { ...sandboxEnv, PATH: binDir } },
    );

    const result = run();
    expect(result.status).toBe(0);
    const record = JSON.parse(result.stdout) as RunRecord;
    expect(record.stage2.map((r) => r.model)).toEqual(['claude', 'codex']);
    expect(record.stage3).toMatchObject({ model: 'claude', response: 'Synthesis from claude' });

    writeFileSync(factory, 'roles:\n  chairman: [claude, codex]\n');
    const invalid = run();
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe('');
    expect(JSON.parse(invalid.stderr.trim().split('\n').at(-1)!).error).toBe(`${factory} roles: chairman: takes one member, not a list`);
  });

  it('should default the agents to the installed, signed-in CLIs without --agents', () => {
    // claude and codex are signed in; gemini's login is unknown (no API key variable); opencode holds a Claude
    // subscription, which doctor warns about. Only claude and codex qualify as default agents.
    const binDir = join(sandbox, 'default-agents-bin');
    const argvLog = join(sandbox, 'default-agents-argv.jsonl');
    mkdirSync(binDir, { recursive: true });
    for (const cli of ['claude', 'codex', 'gemini', 'opencode']) {
      writeFileSync(join(binDir, cli), fakeAgentCli(cli, argvLog), { mode: 0o755 });
    }

    const result = spawnSync(process.execPath, ['--import', tsxLoader, binPath, 'run', '--json', '--no-save', 'Add rate limiting'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...sandboxEnv, PATH: binDir },
    });

    expect(result.stderr).not.toContain('"error"');
    expect(result.status).toBe(0);
    const record = JSON.parse(result.stdout) as RunRecord;
    expect(record.stage1).toEqual([
      { model: 'claude', response: 'Plan from claude' },
      { model: 'codex', response: 'Plan from codex' },
    ]);
    const runs = readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { cli: string });
    expect(runs.map((r) => r.cli)).not.toContain('opencode');
  });

  it('should fail with a pointer to doctor and the terms doc when no agent CLI is signed in', () => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, binPath, 'run', '--json', '--no-save', 'task'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...sandboxEnv, PATH: '' },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const { error } = JSON.parse(result.stderr.trim().split('\n').at(-1)!) as { error: string };
    expect(error).toContain('concilium doctor');
    expect(error).toContain('docs/research/subscription-tos.md');
  });

  it('should report each agent CLI in doctor --json and exit 0 when some are missing', () => {
    // Only a fake codex is on PATH; its shebang names node directly so PATH needs nothing else.
    const binDir = join(sandbox, 'doctor-bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'codex'),
      `#!${process.execPath}\nconst a = process.argv.slice(2).join(' ');\nif (a === '--version') console.log('codex-cli 0.98.0');\nelse if (a === 'login status') console.error('Logged in using ChatGPT');\n`,
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, ['--import', tsxLoader, binPath, 'doctor', '--json'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...sandboxEnv, PATH: binDir },
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { clis: unknown[]; termsOfUse: string };
    expect(report.clis).toEqual([
      { id: 'claude', installed: false },
      { id: 'codex', installed: true, version: '0.98.0', auth: 'subscription' },
      { id: 'gemini', installed: false },
      { id: 'opencode', installed: false },
    ]);
    expect(report.termsOfUse).toMatch(/docs\/research\/subscription-tos\.md$/);
  });

  it('should print a doctor table and the terms link with no agent CLI installed', () => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, binPath, 'doctor'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...sandboxEnv, PATH: '' },
    });

    expect(result.status).toBe(0);
    for (const id of ['claude', 'codex', 'gemini', 'opencode']) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${id}\\s+no\\s+-`, 'm'));
    }
    expect(result.stdout).toContain('subscription-tos.md');
  });
});
