import type { RunRecord } from '@concilium/core';
import type { OutputFormatter } from './formatter.js';

export class JsonFormatter implements OutputFormatter {
  renderComplete(record: RunRecord): void {
    console.log(JSON.stringify(record, null, 2));
  }

  renderError(error: string): void {
    console.error(JSON.stringify({ error }));
  }
}
