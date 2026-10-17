/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodeRunRecord } from '../services/code-service.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('code-run-store');

/**
 * Code runs next to the plan council's runs: `<dataDir>/runs/<run-id>/run.json`. A directory, so the
 * `JsonRunRepository` listing (`<dataDir>/runs/*.json`) never sees it.
 */
export class JsonCodeRunStore {
  constructor(private readonly dataDir: string) {}

  runDir(id: string): string {
    return join(this.dataDir, 'runs', id);
  }

  /** Writes the record and returns its path. */
  async save(record: CodeRunRecord): Promise<string> {
    const dir = this.runDir(record.id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'run.json');
    await writeFile(path, JSON.stringify(record, null, 2) + '\n', 'utf-8');
    return path;
  }

  async load(id: string): Promise<CodeRunRecord> {
    return JSON.parse(await readFile(join(this.runDir(id), 'run.json'), 'utf-8')) as CodeRunRecord;
  }

  /** Every saved code run, by id (oldest first). Directories without a `run.json` (factories) are left out; unreadable ones are logged and left out. */
  async list(): Promise<CodeRunRecord[]> {
    const entries = await readdir(join(this.dataDir, 'runs'), { withFileTypes: true }).catch(() => []);
    const records: CodeRunRecord[] = [];
    for (const id of entries.filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      const path = join(this.runDir(id), 'run.json');
      const text = await readFile(path, 'utf-8').catch(() => null);
      if (text === null) continue;
      try {
        const record = JSON.parse(text) as CodeRunRecord;
        if (record.kind === 'code') records.push(record);
      } catch (err) {
        log.warn(`skipped ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return records;
  }
}
