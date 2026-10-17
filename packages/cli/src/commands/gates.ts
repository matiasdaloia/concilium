/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { join } from 'node:path';
import type { Command } from 'commander';
import { approveGate, GATES_MD, listGates, rejectGate, shellLine, type GateEntry } from '@concilium/core';
import { getDataDir } from '../adapters/xdg-paths.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

function runsDir(): string {
  return join(getDataDir(), 'runs');
}

function fail(err: unknown): never {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

function gateLines(g: GateEntry): string[] {
  const lines = [`${g.id}  ${g.status}  ${g.kind}  ${g.reason}`, `    in ${g.cwd}: ${shellLine(g.command)}`];
  if (g.executedAt) lines.push(`    exit ${g.exitCode} at ${g.executedAt}`);
  return lines;
}

export function registerGatesCommands(program: Command): void {
  program
    .command('gates')
    .description(`List paused actions from each run's ${GATES_MD}`)
    .option('--run <id>', 'Only the gates of this run')
    .option('--json', 'Output the gates as JSON to stdout')
    .action(async (opts: { run?: string; json?: boolean }) => {
      if (opts.run !== undefined && !RUN_ID.test(opts.run)) fail(`invalid run id "${opts.run}"`);
      let gates: GateEntry[];
      try {
        gates = await listGates(runsDir(), opts.run);
      } catch (err) {
        fail(err);
      }
      if (opts.json) console.log(JSON.stringify(gates, null, 2));
      else if (gates.length === 0) console.log('No gates.');
      else for (const g of gates) console.log(gateLines(g).join('\n'));
    });

  program
    .command('approve')
    .description('Approve one paused action and run its command')
    .argument('<gate-id>', 'The gate to approve, as `concilium gates` lists it')
    .action(async (gateId: string) => {
      let gate: GateEntry;
      try {
        gate = await approveGate(runsDir(), gateId);
      } catch (err) {
        fail(err);
      }
      console.log(`Approved ${gate.id}: ${shellLine(gate.command)} (in ${gate.cwd})`);
      console.log(`${gate.status === 'executed' ? 'Executed' : 'Failed'} with exit ${gate.exitCode}`);
      if (gate.output) console.log(gate.output.trimEnd());
      if (gate.status !== 'executed') process.exitCode = 1;
    });

  program
    .command('reject')
    .description('Reject one paused action; its command never runs')
    .argument('<gate-id>', 'The gate to reject, as `concilium gates` lists it')
    .action(async (gateId: string) => {
      try {
        const gate = await rejectGate(runsDir(), gateId);
        console.log(`Rejected ${gate.id}: ${shellLine(gate.command)}`);
      } catch (err) {
        fail(err);
      }
    });
}
