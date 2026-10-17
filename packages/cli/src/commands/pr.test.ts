/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeRunRecord } from '@concilium/core';

const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const binPath = join(cliRoot, 'bin', 'concilium.ts');

const sandbox = mkdtempSync(join(tmpdir(), 'concilium-pr-test-'));
const binDir = join(sandbox, 'bin');
const reviewLog = join(sandbox, 'review.log');
const ghLog = join(sandbox, 'gh.log');
const env: NodeJS.ProcessEnv = {
  // Only the fake agent CLIs, the fake gh, git and node: no real CLI can start.
  PATH: binDir,
  HOME: sandbox,
  XDG_CONFIG_HOME: join(sandbox, 'config'),
  XDG_DATA_HOME: join(sandbox, 'data'),
  XDG_CACHE_HOME: join(sandbox, 'cache'),
  GIT_CONFIG_NOSYSTEM: '1',
};
const runsDir = join(sandbox, 'data', 'concilium', 'runs');
const repo = join(sandbox, 'repo');
const remote = join(sandbox, 'remote.git');

/** Installed and signed in. Asked to review, it logs its name and passes. */
function fakeAgentCli(cli: 'claude' | 'codex'): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (args === '--version') { console.log('1.0.0'); process.exit(0); }
if (args === 'auth status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0); }
if (args === 'login status') { console.log('Logged in using ChatGPT'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(reviewLog)}, ${JSON.stringify(cli)} + ' ' + fs.readFileSync('council-prompt.md', 'utf8').split('\\n')[0] + '\\n');
const text = 'VERDICT: PASS\\nLooks right.';
if (${JSON.stringify(cli)} === 'claude') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }));
else {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}
`;
}

/** Records its argv and cwd, as if it opened a PR. */
const FAKE_GH = `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
console.log('https://example.com/pull/1');
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' }).trimEnd();
}

function concilium(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ['--import', tsxLoader, binPath, ...args], { cwd: sandbox, env, encoding: 'utf8' });
}

const TEST_GATE = {
  plan: { source: 'detected', gates: [{ name: 'test', command: 'node test.js', timeoutMs: 60_000 }], install: null, notes: [] },
  errors: [],
};

/**
 * A run record whose integration branch is the `claude` candidate and a second commit: with `codexGraft`, a graft
 * from `codex` folded in by `claude`, else the trail commit under `.concilium/runs/<run-id>/`. Its `test` gate
 * passes. Written where `concilium` reads code runs.
 */
function writeRun(runId: string, codexGraft: boolean): { record: CodeRunRecord; shipSha: string } {
  const baseSha = git(repo, 'rev-parse', 'main');
  const branch = `concilium/${runId}/integration`;
  const worktree = join(sandbox, `${runId}-wt`);
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, baseSha);
  writeFileSync(join(worktree, 'sum.js'), 'module.exports = (a, b) => Number(a) + Number(b);\n');
  git(worktree, 'commit', '-q', '-am', 'claude candidate');
  const candidateSha = git(worktree, 'rev-parse', 'HEAD');
  const second = codexGraft ? 'second.txt' : `.concilium/runs/${runId}/decisions.tsv`;
  mkdirSync(join(worktree, second, '..'), { recursive: true });
  writeFileSync(join(worktree, second), 'second\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', codexGraft ? 'graft-1' : 'decision trail');
  const secondSha = git(worktree, 'rev-parse', 'HEAD');
  const synthesisPath = join(runsDir, runId, 'synthesis.md');
  mkdirSync(join(runsDir, runId), { recursive: true });
  writeFileSync(synthesisPath, `# Synthesis of run ${runId}\n\nBase: claude\n`);
  const record = {
    version: 1, kind: 'code', id: runId, status: 'done', task: 'make sum accept numeric strings', repoDir: repo, headSha: baseSha, baseSha,
    dissent: { path: null, records: [] },
    candidates: [
      { candidateId: 'claude', provider: 'claude', branch: `concilium/${runId}/claude`, headSha: candidateSha },
      { candidateId: 'codex', provider: 'codex', branch: `concilium/${runId}/codex`, headSha: candidateSha },
    ],
    verification: { ...TEST_GATE, baseline: { lane: 'base', sha: baseSha, install: null, gates: [{ name: 'test', outcome: 'pass' }] } },
    synthesis: {
      base: { candidateId: 'claude', headSha: baseSha, reason: 'best' }, branch, worktree, headSha: secondSha, picker: null, notes: [],
      grafts: codexGraft ? [{ id: 'graft-1', candidateId: 'codex', commitSha: secondSha, status: 'applied', integrator: { provider: 'claude' } }] : [],
      dropouts: [], checks: null, patchPath: null, synthesisPath, mergeable: true, mergeCheck: null,
    },
    trail: { decisionsPath: '', eventsPath: '', rows: 0, commitSha: codexGraft ? null : secondSha, errors: [] },
  } as unknown as CodeRunRecord;
  writeFileSync(join(runsDir, runId, 'run.json'), JSON.stringify(record, null, 2));
  return { record, shipSha: codexGraft ? secondSha : candidateSha };
}

const loadRun = (runId: string) => JSON.parse(readFileSync(join(runsDir, runId, 'run.json'), 'utf8')) as CodeRunRecord;
const remoteBranches = () => git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/');
const remoteHead = (branch: string) => git(remote, 'rev-parse', `refs/heads/${branch}`);

beforeAll(() => {
  writeFileSync(join(sandbox, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  mkdirSync(binDir);
  for (const cli of ['claude', 'codex'] as const) writeFileSync(join(binDir, cli), fakeAgentCli(cli), { mode: 0o755 });
  writeFileSync(join(binDir, 'gh'), FAKE_GH, { mode: 0o755 });
  symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(binDir, 'git'));
  symlinkSync(process.execPath, join(binDir, 'node'));
  git(sandbox, 'init', '-q', '--bare', remote);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'test.js'), "if (require('./sum.js')(1, 2) !== 3) throw new Error('1 + 2');\n");
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe('concilium pr, verify-pr and status', () => {
  it('should verify from another family, push only the verified commit without the trail after approval, and void the verdict after a new commit', () => {
    const runId = '20261017T100000-aaaaaa';
    const { record, shipSha } = writeRun(runId, false);
    const branchHead = git(repo, 'rev-parse', record.synthesis!.branch!);

    const pr = concilium('pr', runId, '--base', 'main');
    expect(pr.status).toBe(0);
    const verdict = loadRun(runId).prVerdict!;
    expect(verdict).toMatchObject({
      verdict: 'PASS', verifier: { provider: 'codex', family: 'openai', sameFamily: false }, authorFamilies: ['anthropic'],
      branchHead, headSha: shipSha, trailSha: branchHead, baseSha: record.baseSha,
    });
    expect(readFileSync(reviewLog, 'utf8')).toBe('codex You are reviewing a change before it becomes a pull request. You did not write it.\n');
    expect(pr.stdout).toContain(`Verdict: PASS at ${shipSha.slice(0, 12)} (base ${record.baseSha.slice(0, 12)}, patch-id ${verdict.patchId!.slice(0, 12)}) by codex (openai)`);
    expect(pr.stdout).not.toContain('Warning');
    expect(pr.stdout).toContain(`The push sends ${shipSha.slice(0, 12)} exactly:`);
    expect(pr.stdout).toContain(`Approve in order:\n  concilium approve ${runId}-g1\n  concilium approve ${runId}-g2\n`);
    expect(existsSync(join(runsDir, runId, 'verification.md'))).toBe(true);
    // Nothing left the machine.
    expect(remoteBranches()).toBe('');
    expect(existsSync(ghLog)).toBe(false);

    // Asked again for the same commit: the same two gates, no new ones.
    const again = concilium('pr', runId, '--base', 'main');
    expect(again.status).toBe(0);
    expect(again.stdout).toContain(`Already paused for ${shipSha.slice(0, 12)}; no new gates:\n  ${runId}-g1  pending  push`);
    expect(JSON.parse(readFileSync(join(runsDir, runId, 'gates.json'), 'utf8')).gates).toHaveLength(2);

    const pending = concilium('status', runId);
    expect(pending.status).toBe(0);
    expect(pending.stdout).toContain(`Verdict: PASS at ${shipSha.slice(0, 12)}`);
    expect(pending.stdout).toContain('\n  valid\n');
    expect(pending.stdout).toContain(`  ${runId}-g1  pending  push  git push origin ${shipSha}:refs/heads/concilium/${runId}`);

    // The branch moves before the approval: the push still sends the verified commit, which has no trail file.
    writeFileSync(join(record.synthesis!.worktree!, 'late.txt'), 'late\n');
    git(record.synthesis!.worktree!, 'add', '.');
    git(record.synthesis!.worktree!, 'commit', '-q', '-m', 'late commit');
    const late = git(repo, 'rev-parse', record.synthesis!.branch!);
    expect(concilium('approve', `${runId}-g1`).status).toBe(0);
    expect(remoteBranches()).toBe(`refs/heads/concilium/${runId}`);
    expect(remoteHead(`concilium/${runId}`)).toBe(shipSha);
    expect(git(remote, 'ls-tree', '-r', '--name-only', `concilium/${runId}`)).toBe('sum.js\ntest.js');
    expect(existsSync(ghLog)).toBe(false);
    expect(concilium('approve', `${runId}-g2`).status).toBe(0);
    const bodyPath = join(runsDir, runId, 'pr-body.md');
    expect(JSON.parse(readFileSync(ghLog, 'utf8'))).toEqual({
      args: ['pr', 'create', '--head', `concilium/${runId}`, '--title', 'make sum accept numeric strings', '--body-file', bodyPath, '--base', 'main'],
      cwd: repo,
    });
    const body = readFileSync(bodyPath, 'utf8');
    expect(body).toContain(`**Verdict: PASS** at \`${shipSha}\``);
    expect(body).toContain(`# Synthesis of run ${runId}`);
    expect(body).toContain(`are in commit \`${branchHead}\` on \`${record.synthesis!.branch}\`, left out of this pull request`);

    git(repo, 'fetch', '-q', 'origin');
    const stale = concilium('status', runId);
    expect(stale.stdout).toContain(`Pushed branch: origin/concilium/${runId} at ${shipSha.slice(0, 12)}`);
    expect(stale.stdout).toContain(`void: ${record.synthesis!.branch} is at ${late.slice(0, 12)}, the verdict is for ${branchHead.slice(0, 12)}; run verify-pr again`);

    // The trail commit is no longer at the head, so the branch cannot ship without it.
    const blocked = concilium('verify-pr', runId);
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain(`Verdict: BLOCKED at no commit`);
    expect(blocked.stdout).toContain(`would ship decision-trail files (.concilium/runs/${runId}/decisions.tsv)`);
  }, 180_000);

  it('should verify from an author family when no other is usable, flag it everywhere, and open only a draft', () => {
    const runId = '20261017T110000-bbbbbb';
    const { shipSha } = writeRun(runId, true);
    const warning = 'Warning: same-family verification: no installed, signed-in CLI outside the author families (anthropic, openai); claude (anthropic) verified. The pull request is a draft.';

    const verify = concilium('verify-pr', runId);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain(`Verdict: PASS at ${shipSha.slice(0, 12)}`);
    expect(verify.stdout).toContain('by claude (anthropic), same family:');
    expect(verify.stdout).toContain(warning);
    expect(loadRun(runId).prVerdict).toMatchObject({ verdict: 'PASS', verifier: { provider: 'claude', sameFamily: true } });

    const pr = concilium('pr', runId, '--base', 'main');
    expect(pr.status).toBe(0);
    expect(pr.stdout).toContain(warning);
    expect(pr.stdout).toContain('(a draft: the verifier is of an author family)');
    expect(pr.stdout).toMatch(new RegExp(`${runId}-g2  pending  pr  gh pr create .* --base main --draft\\n`));
    expect(readFileSync(join(runsDir, runId, 'pr-body.md'), 'utf8')).toContain('> **Warning: same-family verification:');
    expect(readFileSync(join(runsDir, runId, 'verification.md'), 'utf8')).toContain('- verifier: claude (anthropic), SAME FAMILY as the authors');
    expect(concilium('status', runId).stdout).toContain(warning);
  }, 120_000);

  it('should refuse a configured verifier of an author family, or another role, before verifying', () => {
    const runId = '20261017T120000-cccccc';
    writeRun(runId, false);

    for (const command of ['verify-pr', 'pr']) {
      const result = concilium(command, runId, '--role', 'verifier=claude');
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe(
        'Error: [verifier-author-family] --role verifier: verifier claude is of the anthropic family, which wrote the code it verifies (authors: anthropic). '
        + 'Fix: pick a verifier of a family that wrote none of the code, or `auto`; or opt in with allow-same-family-verifier to verify same-family as a draft PR',
      );
      expect(result.stdout).toBe('');
    }
    expect(loadRun(runId).prVerdict).toBeUndefined();

    const other = concilium('verify-pr', runId, '--role', 'judge=codex');
    expect(other.status).toBe(1);
    expect(other.stderr).toContain('Error: [role-not-applicable] --role judge: judge does not apply to concilium verify-pr. Fix: set it with `concilium code --role` or `factory --role`');

    const passes = concilium('verify-pr', runId, '--role', 'verifier=codex');
    expect(passes.status).toBe(0);
    expect(passes.stdout).toContain('by codex (openai)');
  }, 120_000);

  // An author-family verifier verifies only with the explicit opt-in, from any of its sources, and stays flagged.
  const OPT_IN = [
    { name: 'the flag', id: 'eeeee1', args: ['--allow-same-family-verifier'], at: '--allow-same-family-verifier', setup: () => () => {} },
    {
      name: 'factory.yaml', id: 'eeeee2', args: [], at: '.concilium/factory.yaml allow-same-family-verifier',
      setup: () => {
        mkdirSync(join(repo, '.concilium'), { recursive: true });
        writeFileSync(join(repo, '.concilium', 'factory.yaml'), 'allow-same-family-verifier: true\n');
        return () => rmSync(join(repo, '.concilium'), { recursive: true, force: true });
      },
    },
    {
      name: 'saved config', id: 'eeeee3', args: [], at: 'saved config allow-same-family-verifier',
      setup: () => {
        expect(concilium('config', 'set', 'allow-same-family-verifier', 'true').stdout).toContain('allow-same-family-verifier set to: true');
        return () => expect(concilium('config', 'set', 'allow-same-family-verifier', 'false').status).toBe(0);
      },
    },
  ];

  it.each(OPT_IN)('should let a configured author-family verifier verify with the opt-in from $name, flagged everywhere, as a draft PR', ({ id, args, at, setup }) => {
    const runId = `20261017T140000-${id}`;
    const { shipSha } = writeRun(runId, false);
    const teardown = setup();
    try {
      const warning = 'Warning: same-family verification: the configured verifier claude is of an author family (anthropic); allow-same-family-verifier allows it. The pull request is a draft.';
      const pr = concilium('pr', runId, '--base', 'main', '--role', 'verifier=claude', ...args);
      expect(pr.status).toBe(0);
      expect(pr.stderr).toContain(`Warning: [verifier-author-family-allowed] --role verifier: verifier claude is of the anthropic family, which wrote the code it verifies (authors: anthropic); allowed by ${at}, so the verdict is flagged same-family and the PR is a draft.`);
      expect(pr.stdout).toContain(`Verdict: PASS at ${shipSha.slice(0, 12)}`);
      expect(pr.stdout).toContain('by claude (anthropic), same family:');
      expect(pr.stdout).toContain(warning);
      expect(pr.stdout).toContain('(a draft: the verifier is of an author family)');
      expect(pr.stdout).toMatch(new RegExp(`${runId}-g2  pending  pr  gh pr create .* --base main --draft\\n`));
      expect(loadRun(runId).prVerdict).toMatchObject({ verifier: { provider: 'claude', configured: true, sameFamily: true, family: 'anthropic' } });
      expect(readFileSync(join(runsDir, runId, 'pr-body.md'), 'utf8')).toContain(`> **${warning}**`);
      expect(readFileSync(join(runsDir, runId, 'verification.md'), 'utf8')).toContain('- verifier: claude (anthropic), SAME FAMILY as the authors');
      expect(concilium('status', runId).stdout).toContain(warning);
      const verify = concilium('verify-pr', runId, '--role', 'verifier=claude', ...args);
      expect(verify.status).toBe(0);
      expect(verify.stdout).toContain(warning);
    } finally {
      teardown();
    }
    // Without the opt-in the same verifier is refused again.
    expect(concilium('verify-pr', runId, '--role', 'verifier=claude').stderr).toContain('Error: [verifier-author-family]');
  }, 180_000);

  it("should ship a single-candidate run from the candidate's branch", () => {
    const runId = '20261017T130000-dddddd';
    const baseSha = git(repo, 'rev-parse', 'main');
    const branch = `concilium/${runId}/codex`;
    const worktree = join(sandbox, `${runId}-wt`);
    git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, baseSha);
    writeFileSync(join(worktree, 'sum.js'), 'module.exports = (a, b) => Number(a) + Number(b);\n');
    git(worktree, 'commit', '-q', '-am', 'codex candidate');
    const head = git(worktree, 'rev-parse', 'HEAD');
    mkdirSync(join(runsDir, runId), { recursive: true });
    const record = {
      version: 1, kind: 'code', id: runId, status: 'done', task: 'make sum accept numeric strings', repoDir: repo, headSha: baseSha, baseSha,
      dissent: { path: null, records: [] },
      candidates: [{ candidateId: 'codex', provider: 'codex', branch, headSha: head }],
      verification: { ...TEST_GATE, baseline: { lane: 'base', sha: baseSha, install: null, gates: [{ name: 'test', outcome: 'pass' }] } },
      synthesis: {
        base: null, branch: null, worktree: null, headSha: null, picker: null, notes: [], grafts: [], dropouts: [], checks: null,
        patchPath: null, synthesisPath: null, mergeable: false, mergeCheck: null, skipped: 'fewer than 2 candidates',
      },
    };
    writeFileSync(join(runsDir, runId, 'run.json'), JSON.stringify(record, null, 2));

    const pr = concilium('pr', runId);
    expect(pr.status).toBe(0);
    expect(loadRun(runId).prVerdict).toMatchObject({ verdict: 'PASS', branch, headSha: head, authorFamilies: ['openai'], verifier: { provider: 'claude', sameFamily: false } });
    expect(concilium('approve', `${runId}-g1`).status).toBe(0);
    expect(remoteHead(`concilium/${runId}`)).toBe(head);
    expect(concilium('status', runId).stdout).toContain(`Run ${runId}: ${branch} at ${head.slice(0, 12)}`);
  }, 120_000);

  it('should refuse an unknown or invalid run id', () => {
    expect(concilium('status', 'no-such-run')).toMatchObject({ status: 1, stderr: expect.stringContaining('no code run no-such-run') });
    expect(concilium('pr', '../x').status).toBe(1);
  }, 30_000);
});
