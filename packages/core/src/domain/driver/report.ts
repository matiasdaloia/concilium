/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { DriverUsage, RunEvent } from './normalized-event.js';

export const REPORT_STATUSES = ['ok', 'error', 'rate_limited', 'timeout', 'aborted'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export type EventCounts = Record<RunEvent['type'], number>;

/** The result of one headless CLI run. Plain JSON, so it can be written to the run store as is. */
export type Report = {
  version: 1;
  driverId: string;
  /** The model asked for, or null for the CLI's default. */
  model: string | null;
  status: ReportStatus;
  finalText: string;
  events: EventCounts;
  usage: DriverUsage | null;
  durationMs: number;
  errors: string[];
};

export class ReportValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid report: ${problems.join('; ')}`);
    this.name = 'ReportValidationError';
  }
}

function addUsage(total: DriverUsage | null, next: DriverUsage): DriverUsage {
  const costUsd = total?.costUsd === undefined && next.costUsd === undefined ? undefined : (total?.costUsd ?? 0) + (next.costUsd ?? 0);
  return {
    inputTokens: (total?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + next.outputTokens,
    ...(costUsd !== undefined && { costUsd }),
  };
}

/** Builds the report for a finished run from the events it streamed. `finalText` defaults to every text event joined. */
export function buildReport(input: {
  driverId: string;
  model: string | null;
  status: ReportStatus;
  events: RunEvent[];
  durationMs: number;
  finalText?: string;
}): Report {
  const events: EventCounts = { text: 0, tool: 0, usage: 0, rate_limit: 0, error: 0 };
  let usage: DriverUsage | null = null;
  const text: string[] = [];
  const errors: string[] = [];

  for (const event of input.events) {
    events[event.type]++;
    if (event.type === 'text') text.push(event.text);
    if (event.type === 'error' || event.type === 'rate_limit') errors.push(event.message);
    if (event.type === 'usage') usage = addUsage(usage, event.usage);
  }

  return {
    version: 1,
    driverId: input.driverId,
    model: input.model,
    status: input.status,
    finalText: input.finalText ?? text.join(''),
    events,
    usage,
    durationMs: input.durationMs,
    errors,
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Checks an untrusted value (e.g. a report read back from disk) and returns it as a `Report`, or throws naming every bad field. */
export function parseReport(value: unknown): Report {
  if (typeof value !== 'object' || value === null) throw new ReportValidationError(['report: must be an object']);
  const r = value as Record<string, unknown>;
  const problems: string[] = [];

  if (r.version !== 1) problems.push('version: must be 1');
  if (typeof r.driverId !== 'string' || !r.driverId) problems.push('driverId: must be a non-empty string');
  if (r.model !== null && typeof r.model !== 'string') problems.push('model: must be a string or null');
  if (!REPORT_STATUSES.includes(r.status as ReportStatus)) problems.push(`status: must be one of ${REPORT_STATUSES.join(', ')}`);
  if (typeof r.finalText !== 'string') problems.push('finalText: must be a string');
  const events = r.events as Record<string, unknown> | null | undefined;
  for (const type of ['text', 'tool', 'usage', 'rate_limit', 'error'] as const) {
    if (!isCount(events?.[type])) problems.push(`events.${type}: must be a count`);
  }
  const usage = r.usage as Record<string, unknown> | null | undefined;
  if (usage !== null && !(isCount(usage?.inputTokens) && isCount(usage?.outputTokens) && (usage?.costUsd === undefined || isCount(usage.costUsd)))) {
    problems.push('usage: must be null or token counts');
  }
  if (!isCount(r.durationMs)) problems.push('durationMs: must be a count');
  if (!Array.isArray(r.errors) || !r.errors.every((e) => typeof e === 'string')) problems.push('errors: must be an array of strings');

  if (problems.length > 0) throw new ReportValidationError(problems);
  return value as Report;
}
