import type { RunRecord } from '@concilium/core';
import type { OutputFormatter } from './formatter.js';

export class PlainFormatter implements OutputFormatter {
  renderComplete(record: RunRecord): void {
    if (record.stage3?.response) {
      console.log(record.stage3.response);
    } else {
      console.log('No synthesis available.');
    }
  }

  renderError(error: string): void {
    console.error(`Error: ${error}`);
  }
}
