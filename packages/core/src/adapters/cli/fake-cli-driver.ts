/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { parseBrief, type Brief } from '../../domain/driver/brief.js';
import type { NormalizedEvent, RunEvent } from '../../domain/driver/normalized-event.js';
import { buildReport, type ReportStatus } from '../../domain/driver/report.js';
import type { CliDetection, DriverRunOptions, HeadlessCliDriver } from '../../ports/headless-cli-driver.js';

export type FakeCliDriverOptions = {
  id?: string;
  detection?: CliDetection;
  /** Streamed in order by every run. */
  events?: RunEvent[];
  /** Picks the events per run instead of `events`, e.g. a fake juror that reads the brief. */
  respond?: (brief: Brief) => RunEvent[] | Promise<RunEvent[]>;
  /** Defaults to `rate_limited` if a rate_limit event was streamed, `error` if an error was, else `ok`. */
  status?: ReportStatus;
};

/** A scripted `HeadlessCliDriver` for tests: no process, same contract (validated brief, events, one final `done`). */
export class FakeCliDriver implements HeadlessCliDriver {
  readonly id: string;
  /** Every run, in order, for assertions. */
  readonly runs: { brief: Brief; opts: DriverRunOptions }[] = [];

  constructor(private readonly options: FakeCliDriverOptions = {}) {
    this.id = options.id ?? 'fake';
  }

  async detect(): Promise<CliDetection> {
    return this.options.detection ?? { installed: true, version: '1.0.0', auth: 'subscription' };
  }

  async *run(brief: Brief, opts: DriverRunOptions): AsyncGenerator<NormalizedEvent> {
    this.runs.push({ brief: parseBrief(brief), opts });
    const startedAt = Date.now();
    const streamed: RunEvent[] = [];
    let status = this.options.status;
    const events = this.options.respond ? await this.options.respond(brief) : (this.options.events ?? []);

    for (const event of events) {
      if (opts.signal.aborted) {
        status = 'aborted';
        break;
      }
      streamed.push(event);
      yield event;
    }
    if (opts.signal.aborted) status = 'aborted';

    status ??= streamed.some((e) => e.type === 'rate_limit')
      ? 'rate_limited'
      : streamed.some((e) => e.type === 'error')
        ? 'error'
        : 'ok';

    yield {
      type: 'done',
      report: buildReport({ driverId: this.id, model: opts.model ?? null, status, events: streamed, durationMs: Date.now() - startedAt }),
    };
  }
}
