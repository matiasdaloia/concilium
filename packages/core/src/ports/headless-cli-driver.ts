/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { Brief } from '../domain/driver/brief.js';
import type { NormalizedEvent } from '../domain/driver/normalized-event.js';

/** How a CLI is signed in, as far as its own non-secret status output tells. Credential files are never read. */
export type CliAuth = 'subscription' | 'api-key' | 'unknown' | 'none';

export type CliDetection = {
  installed: boolean;
  version?: string;
  auth?: CliAuth;
  notes?: string;
};

export type DriverRunOptions = {
  /** Where the CLI process runs. */
  cwd: string;
  /** Omit to use the CLI's own default model. */
  model?: string;
  timeoutMs: number;
  signal: AbortSignal;
};

/**
 * Drives one installed agent CLI (Claude Code, Codex, Gemini, OpenCode) headlessly under the user's own login.
 * `run` streams normalized events and always ends with one `done` event carrying the `Report`.
 */
export interface HeadlessCliDriver {
  readonly id: string;
  detect(): Promise<CliDetection>;
  run(brief: Brief, opts: DriverRunOptions): AsyncIterable<NormalizedEvent>;
}
