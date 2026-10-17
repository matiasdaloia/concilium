/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { collectDissent, DISSENT_FILE, withDissent, type Dissent, type DissentInput } from '../domain/code-council/dissent.js';
import { reframeMarkdown, type Reframe } from '../domain/code-council/reframe.js';
import { synthesisMarkdown, type Synthesis } from '../domain/code-council/synthesis.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('dissent');

/** The dissent of a code run, and where `dissent.json` was written (null when no report was). */
export type RunDissent = { path: string | null; records: Dissent[] };

export type DissentRunInput = Omit<DissentInput, 'synthesis'> & {
  run: { id: string; task: string; baseSha: string };
  synthesis?: Synthesis;
  reframe?: Reframe;
};

/**
 * M6.1. Collects the run's dissent, takes the "mergeable" label away when open dissent concerns an acceptance line,
 * and, next to the reports the run wrote, writes `dissent.json` and puts the dissent at the top of `synthesis.md`
 * and `reframe.md`.
 */
export async function recordDissent(input: DissentRunInput): Promise<{ dissent: RunDissent; synthesis?: Synthesis }> {
  const records = collectDissent(input);
  const synthesis = input.synthesis && withDissent(input.synthesis, records);
  const dissent: RunDissent = { path: null, records };
  const reports = [synthesis?.synthesisPath, input.reframe?.reportPath].filter((p): p is string => !!p);
  if (reports.length === 0) return { dissent, synthesis };

  try {
    const path = join(dirname(reports[0]), DISSENT_FILE);
    await writeFile(path, `${JSON.stringify({ version: 1, runId: input.run.id, records }, null, 2)}\n`);
    dissent.path = path;
    if (synthesis?.synthesisPath) await writeFile(synthesis.synthesisPath, synthesisMarkdown(synthesis, { ...input.run, ranking: input.ranking }, records));
    if (input.reframe?.reportPath) await writeFile(input.reframe.reportPath, reframeMarkdown(input.reframe, input.run, records));
  } catch (err) {
    log.error(`run ${input.run.id}: could not write the dissent: ${err instanceof Error ? err.message : String(err)}`);
  }
  const open = records.filter((d) => d.resolution === 'open').length;
  log.info(`run ${input.run.id}: ${records.length} dissent records, ${open} open${synthesis?.mergeBlock ? `; ${synthesis.mergeBlock}` : ''}`);
  return { dissent, synthesis };
}
