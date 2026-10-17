/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RunView } from '../shared/run-view';
import { parseRunDir, RUN_FILES, type RunFiles } from './run-view';

/** A run file larger than this is not read: run files are a few hundred kilobytes at most. */
export const MAX_RUN_FILE_BYTES = 16 * 1024 * 1024;

function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Reads a code-run directory a CLI run wrote. Only the files in `RUN_FILES` are read, by name; a file whose real path
 * (after symlinks) is outside the directory, that is not a regular file, or that is too large is skipped with a note.
 * Throws when `dir` is not a directory.
 */
export async function readRunDir(dir: string): Promise<RunView> {
  const root = await realpath(dir);
  if (!(await stat(root)).isDirectory()) throw new Error(`${dir} is not a directory`);
  const files: RunFiles = {};
  const notes: string[] = [];
  for (const name of RUN_FILES) {
    const real = await realpath(path.join(root, name)).catch(() => null);
    if (real === null) continue;
    if (!isInside(root, real)) {
      notes.push(`${name} points outside the run directory; not read`);
      continue;
    }
    const info = await stat(real);
    if (!info.isFile()) {
      notes.push(`${name} is not a file; not read`);
      continue;
    }
    if (info.size > MAX_RUN_FILE_BYTES) {
      notes.push(`${name} is larger than ${MAX_RUN_FILE_BYTES} bytes; not read`);
      continue;
    }
    files[name] = await readFile(real, 'utf8');
  }
  const view = parseRunDir(root, files);
  return { ...view, notes: [...notes, ...view.notes] };
}

/** The value of `--open-run <dir>` or `--open-run=<dir>` in `argv`, resolved against `cwd`; null without one. */
export function openRunArg(argv: readonly string[], cwd: string): string | null {
  const i = argv.findIndex((a) => a === '--open-run' || a.startsWith('--open-run='));
  if (i === -1) return null;
  const value = argv[i].startsWith('--open-run=') ? argv[i].slice('--open-run='.length) : argv[i + 1];
  return value?.trim() ? path.resolve(cwd, value.trim()) : null;
}

/** Where the CLI keeps its runs (`$XDG_DATA_HOME/concilium/runs`, else `~/.local/share/concilium/runs`). */
export function cliRunsDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const data = env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'concilium') : path.join(home, '.local', 'share', 'concilium');
  return path.join(data, 'runs');
}
