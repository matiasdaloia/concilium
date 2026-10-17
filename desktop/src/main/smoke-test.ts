/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { app, type BrowserWindow } from 'electron';
import { createLogger } from '@concilium/core';

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

/**
 * `--smoke-test`: load the main window, check that the renderer mounted with the
 * preload API, then quit with exit code 0, or 1 on a load failure, a crash or a timeout.
 */
export function watchSmokeTest(window: BrowserWindow): void {
  const fail = (reason: string) => {
    log.error(`smoke test failed: ${reason}`);
    app.exit(1);
  };
  const timer = setTimeout(() => fail('timed out'), SMOKE_TIMEOUT_MS);

  window.webContents.once('did-fail-load', (_event, code, description) => fail(`load failed: ${code} ${description}`));
  window.webContents.once('render-process-gone', (_event, details) => fail(`renderer gone: ${details.reason}`));
  window.webContents.once('did-finish-load', () => {
    window.webContents.executeJavaScript(RENDERED_PROBE).then(
      (hasApi: boolean) => {
        clearTimeout(timer);
        if (!hasApi) return fail('window.electronAPI is missing');
        log.info('smoke test passed');
        app.exit(0);
      },
      (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
    );
  });
}
