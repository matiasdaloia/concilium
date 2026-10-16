/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { Report } from './report.js';

/** Token and cost counts. A driver emits increments; the report adds them up. */
export type DriverUsage = {
  inputTokens: number;
  outputTokens: number;
  /** What the CLI reports; for a subscription run this is an API-equivalent estimate, not a charge. */
  costUsd?: number;
};

/** What every headless CLI driver streams, whatever the CLI's own event format. `done` is always last. */
export type NormalizedEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'usage'; usage: DriverUsage }
  | { type: 'rate_limit'; message: string; retryAfterMs?: number }
  | { type: 'error'; message: string }
  | { type: 'done'; report: Report };

export type RunEvent = Exclude<NormalizedEvent, { type: 'done' }>;
