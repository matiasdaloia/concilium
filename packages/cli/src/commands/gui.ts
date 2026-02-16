import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';

export function registerGuiCommand(program: Command): void {
  program
    .command('gui')
    .description('Launch the Concilium desktop GUI')
    .argument('[path]', 'Project directory to open')
    .option('--dev', 'Force development mode')
    .action((projectPath: string | undefined, opts: { dev?: boolean }) => {
      const cwd = projectPath ? resolve(projectPath) : process.cwd();

      // Try to find the desktop package
      const desktopDir = findDesktopDir();
      if (!desktopDir) {
        console.error('Could not find the Concilium desktop application.');
        console.error('Make sure the desktop package is installed.');
        process.exit(1);
      }

      console.log(`Launching Concilium GUI for: ${cwd}`);

      if (opts.dev) {
        const child = spawn('npx', ['electron-forge', 'start', '--', `--cwd=${cwd}`], {
          cwd: desktopDir,
          stdio: 'inherit',
          env: { ...process.env },
        });
        child.on('exit', (code) => process.exit(code ?? 0));
      } else {
        // Try to find the packaged binary
        const child = spawn('electron', ['.', `--cwd=${cwd}`], {
          cwd: desktopDir,
          stdio: 'inherit',
          env: { ...process.env },
        });
        child.on('exit', (code) => process.exit(code ?? 0));
      }
    });
}

function findDesktopDir(): string | null {
  // Check relative to this package
  const candidates = [
    join(dirname(new URL(import.meta.url).pathname), '../../../../desktop'),
    join(process.cwd(), 'desktop'),
    join(dirname(new URL(import.meta.url).pathname), '../../../desktop'),
  ];

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(join(resolved, 'package.json'))) {
      return resolved;
    }
  }

  return null;
}
