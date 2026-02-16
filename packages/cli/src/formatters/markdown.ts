import type { RunRecord } from '@concilium/core';
import type { OutputFormatter } from './formatter.js';

export class MarkdownFormatter implements OutputFormatter {
  renderComplete(record: RunRecord): void {
    console.log(`# Concilium Deliberation\n`);
    console.log(`**Prompt:** ${record.prompt}\n`);
    console.log(`**Date:** ${record.createdAt}\n`);

    if (record.metadata.aggregateRankings.length > 0) {
      console.log(`## Rankings\n`);
      for (const r of record.metadata.aggregateRankings) {
        console.log(`- **${r.model}**: ${r.averageRank.toFixed(2)} avg rank`);
      }
      console.log();
    }

    console.log(`## Synthesis\n`);
    console.log(record.stage3?.response ?? 'No synthesis available.');
    console.log();
  }

  renderError(error: string): void {
    console.error(`## Error\n\n${error}`);
  }
}
