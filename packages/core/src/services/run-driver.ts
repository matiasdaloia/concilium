/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { Brief } from '../domain/driver/brief.js';
import type { Report } from '../domain/driver/report.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';

/** Runs one brief to the end and returns the driver's report. */
export async function runDriver(driver: HeadlessCliDriver, brief: Brief, model: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<Report> {
  let report: Report | undefined;
  for await (const event of driver.run(brief, { cwd: brief.cwd, model, timeoutMs, signal })) {
    if (event.type === 'done') report = event.report;
  }
  if (!report) throw new Error(`${driver.id} ended without a report`);
  return report;
}
