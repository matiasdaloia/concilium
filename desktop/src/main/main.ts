/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { registerIpcHandlers, cancelAllRuns } from './ipc';
import { watchSmokeTest } from './smoke-test';import { createLogger } from '@concilium/core';

const log = createLogger('main');

// Load .env from the application root (where package.json lives)
// app.getAppPath() is the most reliable way in Electron; cwd and __dirname
// can resolve to unexpected locations depending on how the app is launched.
// In development, we also check process.cwd() as a fallback.
const envPath = app.isPackaged
  ? path.join(app.getAppPath(), '.env')
  : path.join(process.cwd(), '.env');

loadEnv({ path: envPath });

// Parse --cwd switch passed by the CLI wrapper (bin/concilium.js).
// Falls back to process.cwd() when launched without the flag.
const cliCwd = app.commandLine.getSwitchValue('cwd');
const resolvedProjectCwd = cliCwd?.trim()
  ? path.resolve(cliCwd.trim())
  : process.cwd();

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0C0C0C',
    titleBarStyle: 'hiddenInset',
    title: `Concilium — ${path.basename(resolvedProjectCwd)}`,
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Handle permission requests for microphone
  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (permission === 'media') {
        log.info('Microphone permission requested');
        callback(true);
      } else {
        callback(false);
      }
    }
  );

  registerIpcHandlers(mainWindow, resolvedProjectCwd);

  if (app.commandLine.hasSwitch('smoke-test')) {
    watchSmokeTest(mainWindow);
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.whenReady().then(() => {
  createWindow();
});

// Cancel active runs on app quit, which stops their agent CLI processes.
// We use `will-quit` (fires after all windows are closed and the app WILL quit)
// in addition to `before-quit` to cover all exit paths.
app.on('before-quit', () => {
  cancelAllRuns();
});

app.on('will-quit', () => {
  cancelAllRuns();
});

// Handle OS signals (Ctrl+C in dev, SIGTERM from process managers)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`Received ${signal}, shutting down`);
    cancelAllRuns();
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
