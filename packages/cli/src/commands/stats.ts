/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { resolve } from 'node:path';
import type { Command } from 'commander';
import { DEFAULT_MIN_SAMPLE, JsonCodeRunStore, ledgerRows, ledgerStats, repoRoot } from '@concilium/core';
import { getDataDir } from '../adapters/xdg-paths.js';
import { statsLines } from '../formatters/stats.js';

interface StatsOptions {
  cwd: string;
  json?: boolean;
  minSample: string;
}

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Win rate by task type and runner')
    .option('--cwd <path>', 'Directory of the git repo whose code runs to count', process.cwd())
    .option('--min-sample <n>', 'Runs of a task type needed before a candidate set is suggested for it', String(DEFAULT_MIN_SAMPLE))
    .option('--json', 'Output the ledger rows and the stats as JSON to stdout')
    .action(async (opts: StatsOptions) => {
      const fail = (message: string): never => {
        console.error(opts.json ? JSON.stringify({ error: message }) : `Error: ${message}`);
        process.exit(1);
      };
      const minSample = Number(opts.minSample);
      if (!Number.isInteger(minSample) || minSample < 1) fail(`--min-sample must be a positive whole number, got "${opts.minSample}"`);
      const repoDir = await repoRoot(resolve(opts.cwd)).catch(() => fail(`${resolve(opts.cwd)} is not inside a git repo`));

      const runs = (await new JsonCodeRunStore(getDataDir()).list()).filter((r) => r.repoDir === repoDir);
      const rows = runs.flatMap(ledgerRows);
      const stats = ledgerStats(rows, minSample);

      if (opts.json) console.log(JSON.stringify({ repoDir, ...stats, rows }, null, 2));
      else for (const line of statsLines(stats, repoDir)) console.log(line);
    });
}
