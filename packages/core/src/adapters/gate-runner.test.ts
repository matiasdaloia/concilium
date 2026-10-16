/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GatePlan } from '../domain/verification/gates.js';
import { setLogLevel } from '../shared/logger.js';
import { gateEnv, GateRunner, OUTPUT_LIMIT } from './gate-runner.js';

const sandbox = mkdtempSync(join(tmpdir(), 'concilium-gates-test-'));
const gitConfig = join(sandbox, 'gitconfig');
const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
let repo: string;
let counter = 0;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trimEnd();
}

function write(files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(repo, path));
      continue;
    }
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function commit(files: Record<string, string | null>): string {
  write(files);
  git('add', '--all');
  git('commit', '-q', '-m', 'change');
  return git('rev-parse', 'HEAD');
}

const runner = new GateRunner({ env });

beforeAll(() => {
  setLogLevel('error');
  writeFileSync(gitConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

beforeEach(() => {
  counter += 1;
  repo = join(sandbox, `repo-${counter}`);
  mkdirSync(repo);
  git('init', '-q');
});

describe('GateRunner.runLane', () => {
  const plan = (gates: Record<string, string>, extra: Partial<GatePlan> = {}): GatePlan => ({
    source: 'verify.yaml', install: null, notes: [], ...extra,
    gates: Object.entries(gates).map(([name, command]) => ({ name, command, timeoutMs: 10_000 })),
  });

  it('should run every gate at the checked-out commit and record its command, exit code, duration and output', async () => {
    const sha = commit({ 'ok.js': 'console.log("all good")\n' });
    const lane = await runner.runLane('c', repo, plan({ ok: 'node ok.js', bad: 'echo broke >&2; exit 3' }));

    expect(lane).toMatchObject({ lane: 'c', sha, install: null });
    expect(lane.gates).toEqual([
      expect.objectContaining({ name: 'ok', command: 'node ok.js', sha, outcome: 'pass', exitCode: 0, output: 'all good\n', truncated: false }),
      expect.objectContaining({ name: 'bad', sha, outcome: 'fail', exitCode: 3, output: 'broke\n' }),
    ]);
    expect(lane.gates.every((g) => g.durationMs >= 0)).toBe(true);
  });

  it('should stop a gate at its timeout, and keep only the end of long output', async () => {
    commit({ 'a.txt': 'a\n' });
    const loud = plan({ loud: `node -e "for (let i = 0; i < 2000; i++) console.log('line ' + i)"` });
    const lane = await runner.runLane('c', repo, { ...loud, gates: [{ name: 'slow', command: 'sleep 5', timeoutMs: 200 }, ...loud.gates] });

    expect(lane.gates[0]).toMatchObject({ outcome: 'timeout' });
    expect(lane.gates[0].durationMs).toBeLessThan(4000);
    expect(lane.gates[1]).toMatchObject({ outcome: 'pass', truncated: true });
    expect(lane.gates[1].output.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    expect(lane.gates[1].output.endsWith('line 1999\n')).toBe(true);
  });

  it('should install only when the skip path is missing', async () => {
    commit({ 'a.txt': 'a\n' });
    const install = { command: 'mkdir node_modules && echo installed', skipIfExists: 'node_modules', timeoutMs: 10_000 };
    const first = await runner.runLane('c', repo, plan({}, { install }));
    expect(first.install).toMatchObject({ name: 'install', outcome: 'pass', output: 'installed\n' });
    const second = await runner.runLane('c', repo, plan({}, { install }));
    expect(second.install).toBeNull();
  });

  it('should not hand credentials or npm settings to gate commands', () => {
    const clean = gateEnv({ PATH: '/bin', HOME: '/h', OPENROUTER_API_KEY: 'k', GH_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', npm_config_prefix: '/p', GIT_DIR: '/g' });
    expect(clean).toEqual({ PATH: '/bin', HOME: '/h', CI: '1' });
  });
});

describe('GateRunner.integrity', () => {
  const base = () => commit({
    'src/sum.js': 'module.exports = (a, b) => a + b;\n',
    'src/sum.test.js': "it('adds', () => {});\nit('negatives', () => {});\n",
    'vitest.config.ts': 'export default { test: { coverage: { thresholds: { lines: 90 } } } };\n',
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' }, dependencies: { lodash: '^4' } }, null, 2) + '\n',
    'requirements.txt': 'requests==2.0\n',
    'README.md': 'Use it.skip to skip a test.\n',
  });

  it('should find nothing in a change that only touches the code', async () => {
    const from = base();
    const to = commit({ 'src/sum.js': 'module.exports = (a, b) => Number(a) + Number(b);\n', 'src/new.test.js': "it('more', () => {});\n" });
    expect(await runner.integrity(repo, from, to)).toEqual([]);
  });

  it('should disqualify a deleted test file, with the deleted lines as evidence', async () => {
    const from = base();
    const to = commit({ 'src/sum.test.js': null });
    expect(await runner.integrity(repo, from, to)).toEqual([expect.objectContaining({
      rule: 'deleted-test', severity: 'disqualify', path: 'src/sum.test.js',
      evidence: expect.stringContaining("-it('negatives', () => {});"),
    })]);
  });

  it('should disqualify new skip and only markers, but not ones that were already there or in prose', async () => {
    const from = base();
    const to = commit({
      'src/sum.test.js': "it.skip('adds', () => {});\nit('negatives', () => {});\n",
      'src/other_test.go': 'func TestX(t *testing.T) { t.Skip("later") }\n',
      'src/model.py': 'model.fit(x)\n',
      'README.md': 'Use it.skip or it.only to focus.\n',
    });
    const findings = await runner.integrity(repo, from, to);
    expect(findings.map((f) => [f.rule, f.path, f.severity])).toEqual([
      ['skipped-test', 'src/other_test.go', 'disqualify'],
      ['skipped-test', 'src/sum.test.js', 'disqualify'],
    ]);
    expect(findings[1].evidence).toContain("+it.skip('adds', () => {});");

    const unchanged = commit({ 'src/sum.test.js': "it.skip('adds', () => {});\nit('negatives', () => { /* edited */ });\n" });
    expect(await runner.integrity(repo, to, unchanged)).toEqual([]);
  });

  it('should disqualify a lowered coverage threshold, and penalize the edit to the runner config', async () => {
    const from = base();
    const to = commit({ 'vitest.config.ts': 'export default { test: { coverage: { thresholds: { lines: 60 } } } };\n' });
    const findings = await runner.integrity(repo, from, to);
    expect(findings.map((f) => [f.rule, f.severity])).toEqual([['lowered-coverage', 'disqualify'], ['gate-config', 'penalty']]);
    expect(findings[0].message).toBe('lowered the lines coverage threshold in vitest.config.ts from 90 to 60');
  });

  it('should penalize edits to gate config, CI files and gate scripts', async () => {
    const from = base();
    const to = commit({
      'tsconfig.json': '{ "compilerOptions": { "strict": false } }\n',
      '.github/workflows/ci.yml': 'on: push\n',
      '.concilium/verify.yaml': 'gates: {}\n',
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'exit 0' }, dependencies: { lodash: '^4' } }, null, 2) + '\n',
    });
    const findings = await runner.integrity(repo, from, to);
    expect(findings.map((f) => [f.rule, f.path, f.severity]).sort()).toEqual([
      ['gate-config', '.concilium/verify.yaml', 'penalty'],
      ['gate-config', '.github/workflows/ci.yml', 'penalty'],
      ['gate-config', 'package.json', 'penalty'],
      ['gate-config', 'tsconfig.json', 'penalty'],
    ]);
  });

  it('should penalize added dependencies in package.json, requirements, go.mod and Cargo.toml', async () => {
    const from = base();
    const to = commit({
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' }, dependencies: { lodash: '^5' }, devDependencies: { 'left-pad': '1' } }, null, 2) + '\n',
      'requirements.txt': 'requests==2.1\nnumpy>=1\n',
      'go.mod': 'module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/pkg/errors v0.9.1\n)\n',
      'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n\n[dev-dependencies.proptest]\nversion = "1"\n',
    });
    const findings = await runner.integrity(repo, from, to);
    expect(findings.map((f) => f.message).sort()).toEqual([
      'added a dependency in go.mod: github.com/pkg/errors',
      'added a dependency in package.json: left-pad',
      'added a dependency in requirements.txt: numpy',
      'added dependencies in Cargo.toml: serde, proptest',
    ]);
    expect(findings.every((f) => f.severity === 'penalty')).toBe(true);
    expect(findings.find((f) => f.path === 'package.json')!.evidence).toContain('+    "left-pad": "1"');
  });

  it('should treat a test file moved out of the test paths as deleted', async () => {
    const from = base();
    git('mv', 'src/sum.test.js', 'src/sum.notes.js');
    git('commit', '-q', '-m', 'move');
    const findings = await runner.integrity(repo, from, git('rev-parse', 'HEAD'));
    expect(findings).toEqual([expect.objectContaining({ rule: 'deleted-test', message: 'moved the test file src/sum.test.js to src/sum.notes.js, where it no longer runs as a test' })]);
  });
});
