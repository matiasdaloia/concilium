import type { Command } from 'commander';
import { JsonRunRepository } from '@concilium/core';
import { getDataDir } from '../adapters/xdg-paths.js';

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('List or view past deliberation runs')
    .argument('[run-id]', 'View a specific run by ID')
    .option('--json', 'Output as JSON')
    .option('--last', 'Show the most recent run')
    .option('--synthesis', 'Show only the synthesis text (use with --last)')
    .action(async (runId: string | undefined, opts: { json?: boolean; last?: boolean; synthesis?: boolean }) => {
      const repo = new JsonRunRepository(getDataDir());

      if (opts.last) {
        const runs = await repo.list();
        if (runs.length === 0) {
          console.log('No runs found.');
          return;
        }
        runId = runs[0].id;
      }

      if (runId) {
        // Show specific run
        try {
          const run = await repo.load(runId);
          if (opts.json) {
            console.log(JSON.stringify(run, null, 2));
          } else if (opts.synthesis) {
            console.log(run.stage3?.response ?? 'No synthesis available.');
          } else {
            console.log(`Run: ${run.id}`);
            console.log(`Date: ${run.createdAt}`);
            console.log(`Prompt: ${run.prompt.slice(0, 100)}${run.prompt.length > 100 ? '...' : ''}`);
            console.log(`Agents: ${run.agents.map((a) => `${a.name} (${a.status})`).join(', ')}`);
            console.log(`Rankings: ${run.metadata.aggregateRankings.map((r) => `${r.model}: ${r.averageRank}`).join(', ')}`);
            console.log(`\nSynthesis:\n`);
            console.log(run.stage3?.response ?? 'No synthesis available.');
          }
        } catch {
          console.error(`Run not found: ${runId}`);
          process.exit(1);
        }
        return;
      }

      // List all runs
      const runs = await repo.list();
      if (runs.length === 0) {
        console.log('No runs found.');
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(runs, null, 2));
        return;
      }

      console.log(`\n  ${'ID'.padEnd(38)} ${'Date'.padEnd(22)} ${'Status'.padEnd(15)} Prompt`);
      console.log(`  ${'-'.repeat(38)} ${'-'.repeat(22)} ${'-'.repeat(15)} ${'-'.repeat(40)}`);
      for (const run of runs) {
        const date = new Date(run.createdAt).toLocaleString();
        console.log(`  ${run.id.padEnd(38)} ${date.padEnd(22)} ${run.status.padEnd(15)} ${run.promptPreview}`);
      }
      console.log();
    });
}
