/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { registerIpcHandlers, cancelAllRuns } from './ipc';

// Load .env from the application root (where package.json lives)
// app.getAppPath() is the most reliable way in Electron; cwd and __dirname
// can resolve to unexpected locations depending on how the app is launched.
// In development, we also check process.cwd() as a fallback.
const envPath = app.isPackaged 
  ? path.join(app.getAppPath(), '.env') 
  : path.join(process.cwd(), '.env');

loadEnv({ path: envPath });

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0C0C0C',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerIpcHandlers(mainWindow);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.whenReady().then(createWindow);

// Kill all spawned agent processes (opencode, claude, codex) on app quit.
// Without this, child processes become orphans that keep running indefinitely.
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
