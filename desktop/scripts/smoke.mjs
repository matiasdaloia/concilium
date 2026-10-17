/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

// Starts the app packaged by `npm run package` under xvfb-run with --smoke-test,
// in throwaway HOME and XDG dirs, and exits with the app's exit code.
// The app gets an empty PATH, so the agent detection the home screen runs
// finds no real agent CLI. Linux only; needs xvfb-run.
// `-- --open-run <dir>` also opens that code-run directory; the app prints its rendered ranking to stdout.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binary = path.join(desktopDir, 'out', `Concilium-linux-${process.arch}`, 'Concilium');
if (!existsSync(binary)) {
  console.error(`No packaged app at ${binary}; run \`npm run package -w concilium\` first.`);
  process.exit(1);
}

// npm runs this from desktop/; a relative --open-run is relative to where npm was started.
const args = process.argv.slice(2);
const openRunAt = args.indexOf('--open-run');
if (openRunAt !== -1 && !args[openRunAt + 1]) {
  console.error('--open-run needs a run directory');
  process.exit(1);
}
const openRun = openRunAt === -1 ? [] : [`--open-run=${path.resolve(process.env.INIT_CWD ?? process.cwd(), args[openRunAt + 1])}`];

const home = mkdtempSync(path.join(tmpdir(), 'concilium-smoke-'));
try {
  const emptyBin = path.join(home, 'bin');
  mkdirSync(emptyBin);
  const appArgs = ['env', `PATH=${emptyBin}`, binary, '--smoke-test', `--cwd=${home}`, ...openRun];
  const result = spawnSync('xvfb-run', ['-a', ...appArgs], {
    cwd: home,
    stdio: 'inherit',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_DATA_HOME: path.join(home, 'data'),
      XDG_CACHE_HOME: path.join(home, 'cache'),
    },
  });
  if (result.error) {
    console.error(`smoke test could not run: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
