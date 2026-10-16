/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  CODE_TIMEOUT_MS,
  createConciliumRuntime,
  GitWorktreeWorkspace,
  JsonCodeRunStore,
  JsonConfigStore,
  JsonRunRepository,
  PlaintextSecretStore,
  runCodeCandidates,
  type CodeAgent,
  type CodeCandidate,
  type CodeRunRecord,
} from '@concilium/core';
import { getConfigDir, getDataDir, getWorktreeRoot } from '../adapters/xdg-paths.js';

interface CodeOptions {
  agents?: string;
  cwd: string;
  includeDirty?: boolean;
  timeout?: string;
  json?: boolean;
}

function parseAgents(list: string): CodeAgent[] {
  return list.split(',').map((s) => s.trim()).filter(Boolean).map((spec) => {
    const [provider, model] = spec.includes(':') ? spec.split(':', 2) : [spec, ''];
    return { provider: provider.trim(), ...(model.trim() && { model: model.trim() }) };
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function summaryRows(candidates: CodeCandidate[]): string[][] {
  return [
    ['Candidate', 'Status', 'Files', '+/-', 'Commits', 'Duration', 'Tokens in/out', 'Branch'],
    ...candidates.map((c) => [
      c.candidateId,
      c.status,
      c.diffStat ? String(c.diffStat.filesChanged) : '-',
      c.diffStat ? `+${c.diffStat.insertions}/-${c.diffStat.deletions}` : '-',
      c.diffStat ? String(c.diffStat.commits) : '-',
      formatDuration(c.durationMs),
      c.usage ? `${c.usage.inputTokens}/${c.usage.outputTokens}` : '-',
      c.branch,
    ]),
  ];
}

function printSummary(record: CodeRunRecord, savedTo: string | null): void {
  const rows = summaryRows(record.candidates);
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  console.log(`\n  Run ${record.id} in ${record.repoDir}`);
  console.log(`  Base ${record.baseSha}${record.snapshotRef ? ` (dirty-tree snapshot of ${record.headSha})` : ''}\n`);
  for (const row of rows) console.log(`  ${row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd()}`);

  const failed = record.candidates.filter((c) => c.errors.length > 0);
  if (failed.length > 0) {
    console.log('\n  Errors:');
    for (const c of failed) for (const error of c.errors) console.log(`    ${c.candidateId}: ${error.split('\n')[0]}`);
  }

  console.log('\n  Inspect:');
  for (const c of record.candidates.filter((c) => c.headSha)) {
    console.log(`    git -C ${record.repoDir} diff ${record.baseSha.slice(0, 12)}..${c.branch}`);
    console.log(`      worktree: ${c.worktree}`);
  }
  console.log(`\n  Clean up: concilium gc --run ${record.id}`);
  if (savedTo) console.log(`  Run saved: ${savedTo}`);
  console.log();
}

export function registerCodeCommand(program: Command): void {
  program
    .command('code')
    .description('Have agent CLIs write code, one git worktree each')
    .argument('[task...]', 'The coding task')
    .option('--agents <list>', 'Candidate agents (e.g. "claude,codex" or "claude:opus,codex:gpt-5.2-codex"); default: the installed, signed-in agent CLIs (see `concilium doctor`)')
    .option('--cwd <path>', 'Directory of the git repo to work on', process.cwd())
    .option('--include-dirty', 'Start from the uncommitted changes too (snapshotted to a scratch ref) instead of refusing a dirty tree')
    .option('--timeout <minutes>', `Wall-clock limit per candidate in minutes (default: ${CODE_TIMEOUT_MS / 60_000})`)
    .option('--json', 'Output the run record as JSON to stdout')
    .action(async (taskParts: string[], opts: CodeOptions) => {
      const fail = (message: string): never => {
        console.error(opts.json ? JSON.stringify({ error: message }) : `Error: ${message}`);
        process.exit(1);
      };

      const task = taskParts.join(' ').trim();
      if (!task) fail('No task provided. Use `concilium code "<task>"`.');
      const timeoutMinutes = opts.timeout === undefined ? undefined : Number(opts.timeout);
      if (timeoutMinutes !== undefined && !(timeoutMinutes > 0)) fail(`--timeout must be a positive number of minutes, got "${opts.timeout}"`);

      const runtime = createConciliumRuntime({
        secretStore: new PlaintextSecretStore(),
        configStore: new JsonConfigStore(getConfigDir()),
        runRepository: new JsonRunRepository(getDataDir()),
      });

      let record: CodeRunRecord;
      let savedTo: string | null = null;
      try {
        const agents = opts.agents
          ? parseAgents(opts.agents)
          : (await runtime.defaultAgentInstances()).map((a) => ({ provider: a.provider }));
        if (agents.length === 0) fail('--agents names no agent');

        // Progress goes to stderr so stdout holds only the summary or the JSON.
        const progress = (line: string) => !opts.json && console.error(line);
        record = await runCodeCandidates({
          task,
          repoDir: resolve(opts.cwd),
          agents,
          includeDirty: opts.includeDirty,
          timeoutMs: timeoutMinutes === undefined ? undefined : timeoutMinutes * 60_000,
          drivers: runtime.drivers,
          workspace: new GitWorktreeWorkspace({ root: getWorktreeRoot() }),
          onCandidateStart: (c) => progress(`  ▶ ${c.candidateId}: running in ${c.worktree}`),
          onCandidateDone: (c) => progress(`  ${c.status === 'ok' ? '✓' : '✗'} ${c.candidateId}: ${c.status} in ${formatDuration(c.durationMs)}`),
        });
        savedTo = await new JsonCodeRunStore(getDataDir()).save(record).catch((err: Error) => {
          console.error(`Warning: could not save the run record: ${err.message}`);
          return null;
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }

      if (opts.json) console.log(JSON.stringify(record, null, 2));
      else printSummary(record, savedTo);
      if (record.candidates.every((c) => c.status !== 'ok')) process.exitCode = 1;
    });
}
