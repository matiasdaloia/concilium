/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { rankCells, rankingLine } from '../shared/run-view';
import { cliRunsDir, openRunArg, readRunDir } from './run-dir';

/** Written by `desktop/scripts/make-run-fixture.mjs`. */
const FIXTURE = fileURLToPath(new URL('./__fixtures__/code-run', import.meta.url));
const sandbox = mkdtempSync(path.join(tmpdir(), 'concilium-run-dir-'));

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe('readRunDir', () => {
  it('should show the same ranking as the synthesis.md of the run directory the CLI wrote', async () => {
    const view = await readRunDir(FIXTURE);
    const synthesis = readFileSync(path.join(FIXTURE, 'synthesis.md'), 'utf8');

    expect(view.notes).toEqual([]);
    expect(view.dir).toBe(FIXTURE);
    expect(view.ranking?.rows.map((row) => rankingLine(rankCells(row)))).toEqual(synthesis.split('\n').filter((line) => /^\| \d+ \| /.test(line)));
    expect(view.ranking?.rows.map((row) => row.candidateId)).toEqual(['codex', 'claude']);
    expect(view.verdict?.verdict).toBe('PASS');
  });

  it('should not read a run file whose real path is outside the run directory', async () => {
    const outside = path.join(sandbox, 'secret.json');
    writeFileSync(outside, JSON.stringify({ version: 1, kind: 'code', id: 'stolen', task: 'secret' }));
    const dir = path.join(sandbox, 'escape');
    mkdirSync(dir);
    symlinkSync(outside, path.join(dir, 'run.json'));
    symlinkSync('../../etc/passwd', path.join(dir, 'synthesis.md'));
    mkdirSync(path.join(dir, 'decisions.tsv'));

    const view = await readRunDir(dir);
    expect(view.runId).toBeNull();
    expect(view.task).toBeNull();
    expect(view.reports.synthesis).toBeNull();
    expect(view.notes).toEqual([
      'run.json points outside the run directory; not read',
      'decisions.tsv is not a file; not read',
      'no run.json: showing only the reports',
    ]);
  });

  it('should read a run directory reached through a symlink, and refuse what is not a directory', async () => {
    const link = path.join(sandbox, 'linked-run');
    symlinkSync(FIXTURE, link);
    const view = await readRunDir(link);
    expect(view.dir).toBe(FIXTURE);
    expect(view.runId).toBe(JSON.parse(readFileSync(path.join(FIXTURE, 'run.json'), 'utf8')).id);

    await expect(readRunDir(path.join(FIXTURE, 'run.json'))).rejects.toThrow('is not a directory');
    await expect(readRunDir(path.join(sandbox, 'nope'))).rejects.toThrow('ENOENT');
  });

  it('should show an empty view with a note for a directory that holds no run files', async () => {
    const empty = path.join(sandbox, 'empty');
    mkdirSync(empty);
    const view = await readRunDir(empty);
    expect(view).toMatchObject({ runId: null, ranking: null, candidates: [], dissent: [], trail: [], notes: ['no run.json: showing only the reports'] });
  });
});

describe('openRunArg', () => {
  it('should take --open-run <dir> or --open-run=<dir>, resolved against the cwd', () => {
    expect(openRunArg(['electron', '.', '--smoke-test', '--open-run', 'runs/a'], '/home/u')).toBe('/home/u/runs/a');
    expect(openRunArg(['app', '--open-run=/data/runs/b'], '/home/u')).toBe('/data/runs/b');
    expect(openRunArg(['app', '--smoke-test'], '/home/u')).toBeNull();
    expect(openRunArg(['app', '--open-run'], '/home/u')).toBeNull();
    expect(openRunArg(['app', '--open-run='], '/home/u')).toBeNull();
  });
});

describe('cliRunsDir', () => {
  it('should be where the CLI saves its runs', () => {
    expect(cliRunsDir({ XDG_DATA_HOME: '/xdg' }, '/home/u')).toBe('/xdg/concilium/runs');
    expect(cliRunsDir({}, '/home/u')).toBe('/home/u/.local/share/concilium/runs');
  });
});
