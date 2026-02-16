import type { RunRecord } from '@concilium/core';

export interface OutputFormatter {
  renderComplete(record: RunRecord): void;
  renderError(error: string): void;
}
