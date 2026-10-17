/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { app, type BrowserWindow } from 'electron';
import { createLogger } from '@concilium/core';
import { rankingLine } from '../shared/run-view';

const log = createLogger('smoke-test');

const SMOKE_TIMEOUT_MS = 30_000;

// Resolves once React has rendered into #root, with whether the preload API is there.
const RENDERED_PROBE = `new Promise((resolve) => {
  const check = () => {
    const root = document.getElementById('root');
    if (root && root.childElementCount > 0) {
      resolve(typeof window.electronAPI?.getConfig === 'function');
    } else {
      setTimeout(check, 100);
    }
  };
  check();
})`;

type RunProbe = { error: string } | { runId: string | null; rows: string[][] };

// Resolves once the run viewer shows the --open-run directory (or an error), with the cells of each ranking row.
const RUN_PROBE = `new Promise((resolve) => {
  const check = () => {
    const error = document.querySelector('[data-run-error]');
    if (error) return resolve({ error: error.textContent });
    const view = document.querySelector('[data-run-view]');
    if (!view) return setTimeout(check, 100);
    const rows = [...document.querySelectorAll('[data-ranking-row]')].map((row) => [...row.querySelectorAll('td')].map((td) => td.textContent.trim()));
    resolve({ runId: view.getAttribute('data-run-id'), rows });
  };
  check();
})`;

/**
 * `--smoke-test`: load the main window, check that the renderer mounted with the preload API, then quit with exit
 * code 0, or 1 on a load failure, a crash or a timeout. With `--open-run <dir>`, it also waits for the run viewer to
 * show that directory and prints its rendered ranking to stdout, one `synthesis.md` table line per row; no ranking
 * rendered is a failure.
 */
export function watchSmokeTest(window: BrowserWindow, options: { openRun: string | null }): void {
  const fail = (reason: string) => {
    log.error(`smoke test failed: ${reason}`);
    app.exit(1);
  };
  const timer = setTimeout(() => fail('timed out'), SMOKE_TIMEOUT_MS);

  /** Prints the rendered ranking; returns why it could not. */
  const checkRun = async (dir: string): Promise<string | null> => {
    const probe = (await window.webContents.executeJavaScript(RUN_PROBE)) as RunProbe;
    if ('error' in probe) return `could not open ${dir}: ${probe.error}`;
    if (probe.rows.length === 0) return `the run viewer shows no ranking for ${dir}`;
    process.stdout.write(`Ranking of run ${probe.runId ?? '(no id)'} in ${dir}:\n${probe.rows.map(rankingLine).join('\n')}\n`);
    return null;
  };

  window.webContents.once('did-fail-load', (_event, code, description) => fail(`load failed: ${code} ${description}`));
  window.webContents.once('render-process-gone', (_event, details) => fail(`renderer gone: ${details.reason}`));
  window.webContents.once('did-finish-load', () => {
    window.webContents.executeJavaScript(RENDERED_PROBE).then(
      async (hasApi: boolean) => {
        if (!hasApi) return fail('window.electronAPI is missing');
        const runFailure = options.openRun ? await checkRun(options.openRun) : null;
        if (runFailure) return fail(runFailure);
        clearTimeout(timer);
        log.info('smoke test passed');
        app.exit(0);
      },
      (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
    ).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  });
}
