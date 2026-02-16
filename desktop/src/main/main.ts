/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { registerIpcHandlers, cancelAllRuns } from './ipc';
import { ensureOpenCodeServer, createLogger } from '@concilium/core';

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

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.whenReady().then(async () => {
  // Start the embedded OpenCode server early so it's ready when agents run.
  // If OPENCODE_SERVER_URL is set, it connects to an external server instead.
  const serverUrl = process.env.OPENCODE_SERVER_URL;
  ensureOpenCodeServer(serverUrl ? { serverUrl } : { embedded: true }).catch(
    (err) => log.warn('OpenCode server init deferred:', err instanceof Error ? err.message : String(err)),
  );

  createWindow();
});

// Cancel active runs and shut down the embedded OpenCode server on app quit.
app.on('before-quit', () => {
  cancelAllRuns();
});

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
