/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { Command } from 'commander';
import { checkTrail, DECISIONS_FILE, EVENTS_FILE, JsonCodeRunStore, type TrailCheck } from '@concilium/core';
import { getDataDir } from '../adapters/xdg-paths.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function registerTrailCommand(program: Command): void {
  const trail = program.command('trail').description('Audit the decision trail of a code run');

  trail
    .command('check')
    .description(`Check every ${DECISIONS_FILE} row against ${EVENTS_FILE} and resolve its evidence; exits 1 on a problem`)
    .requiredOption('--run <id>', 'The code run to check')
    .option('--json', 'Output the result as JSON to stdout')
    .action(async (opts: { run: string; json?: boolean }) => {
      if (!RUN_ID.test(opts.run)) {
        console.error(`Error: invalid run id "${opts.run}"`);
        process.exit(1);
      }
      const runDir = new JsonCodeRunStore(getDataDir()).runDir(opts.run);
      let result: TrailCheck;
      try {
        result = await checkTrail(runDir);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      if (opts.json) console.log(JSON.stringify({ runDir, ...result }, null, 2));
      else if (result.problems.length === 0) console.log(`Trail of run ${opts.run}: ${result.rows} decisions, ${result.events} events, every row matches its event and its evidence resolves.`);
      else {
        console.log(`Trail of run ${opts.run} (${runDir}): ${result.problems.length} problems`);
        for (const p of result.problems) console.log(`  ${p.line ? `${DECISIONS_FILE}:${p.line}: ` : ''}${p.message}`);
      }
      if (result.problems.length > 0) process.exitCode = 1;
    });
}
