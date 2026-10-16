/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { Command } from 'commander';
import { GitWorktreeWorkspace, type GcRunResult } from '@concilium/core';
import { getWorktreeRoot } from '../adapters/xdg-paths.js';

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describeRun(result: GcRunResult, dryRun: boolean): string {
  const head = `  ${result.runId}${result.repoDir ? ` (${result.repoDir})` : ''}:`;
  if (result.skipped) return `${head} still running, skipped`;
  const removed = dryRun ? 'would remove' : 'removed';
  const deleted = dryRun ? 'would delete' : 'deleted';
  const parts = [
    `${removed} ${count(result.removedWorktrees.length, 'worktree', 'worktrees')}`,
    `${deleted} ${count(result.deletedBranches.length, 'branch', 'branches')}`,
  ];
  if (result.deletedRefs.length > 0) parts.push(`${deleted} ${result.deletedRefs.join(', ')}`);
  if (result.keptBranches.length > 0) parts.push(`kept ${result.keptBranches.join(', ')}`);
  return `${head} ${parts.join(', ')}`;
}

export function registerGcCommand(program: Command): void {
  program
    .command('gc')
    .description('Remove worktrees and branches of finished runs')
    .option('--run <id>', 'Only this run')
    .option('--dry-run', 'Show what would be removed, change nothing')
    .action(async (opts: { run?: string; dryRun?: boolean }) => {
      const dryRun = Boolean(opts.dryRun);
      let results: GcRunResult[];
      try {
        results = await new GitWorktreeWorkspace({ root: getWorktreeRoot() }).gc({ runId: opts.run, dryRun });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      if (results.length === 0) {
        console.log(opts.run ? `No worktrees recorded for run ${opts.run}.` : 'Nothing to collect.');
        return;
      }
      for (const result of results) {
        console.log(describeRun(result, dryRun));
        for (const error of result.errors) console.error(`  ${result.runId}: ${error}`);
      }
      if (results.some((r) => r.errors.length > 0)) process.exitCode = 1;
    });
}
