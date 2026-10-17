/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

// Machine-checked rules from AGENTS.md. Run with `npm run test:repo` (part of `npm test`).
// Needs a built core (`npm run build:core`): the docs check runs the CLI from source.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Tracked .ts/.tsx files under packages/ and desktop/ without the MIT header.
 * Ratchet: this may only go down. Lower it when you add headers; never raise it.
 */
const MISSING_HEADER_BASELINE = 78;

const HEADER = 'SPDX-License-Identifier: MIT';
const DOCS = ['AGENTS.md', 'README.md', 'packages/cli/README.md'];

function trackedFiles(...pathspecs) {
  return execFileSync('git', ['ls-files', '--', ...pathspecs], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function read(file) {
  return readFileSync(join(ROOT, file), 'utf8');
}

describe('license headers', () => {
  it(`should not add files without the MIT header (ratchet: ${MISSING_HEADER_BASELINE})`, () => {
    const missing = trackedFiles('packages/*.ts', 'packages/*.tsx', 'desktop/*.ts', 'desktop/*.tsx')
      .filter((file) => !read(file).includes(HEADER));

    assert.ok(
      missing.length <= MISSING_HEADER_BASELINE,
      `${missing.length} files lack the MIT header, the baseline is ${MISSING_HEADER_BASELINE}. ` +
        'Add the header from AGENTS.md to every new file.',
    );
    assert.equal(
      missing.length,
      MISSING_HEADER_BASELINE,
      `Only ${missing.length} files lack the header now. Lower MISSING_HEADER_BASELINE to ${missing.length}.`,
    );
  });
});

describe('core boundaries', () => {
  const coreFiles = trackedFiles('packages/core/src/*.ts');
  const corePkg = JSON.parse(read('packages/core/package.json'));
  const allowed = new Set([...Object.keys(corePkg.dependencies ?? {}), ...Object.keys(corePkg.devDependencies ?? {})]);
  const builtins = new Set(builtinModules);

  function importsOf(file) {
    const source = read(file);
    return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  }

  function packageName(specifier) {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  }

  it('should import only its own files, node builtins and its declared dependencies', () => {
    const coreDir = join(ROOT, 'packages/core');
    const violations = [];
    for (const file of coreFiles) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(join(ROOT, file)), specifier);
          if (relative(coreDir, target).startsWith('..')) violations.push(`${file}: ${specifier}`);
        } else if (!specifier.startsWith('node:') && !builtins.has(specifier) && !allowed.has(packageName(specifier))) {
          violations.push(`${file}: ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, [], 'core must not import the CLI, the desktop app or undeclared packages');
  });

  it('should log through createLogger, not console, outside shared/logger.ts', () => {
    const offenders = coreFiles
      .filter((file) => !file.endsWith('.test.ts') && file !== 'packages/core/src/shared/logger.ts')
      .filter((file) => /\bconsole\./.test(read(file)));

    assert.deepEqual(offenders, []);
  });
});

describe('cli output', () => {
  it('should write to the console only from commands and formatters', () => {
    const offenders = trackedFiles('packages/cli/src/*.ts', 'packages/cli/src/*.tsx')
      .filter((file) => !/^packages\/cli\/src\/(commands|formatters)\//.test(file) && !file.endsWith('.test.ts'))
      .filter((file) => /\bconsole\./.test(read(file)));

    assert.deepEqual(offenders, [], 'diagnostics go through createLogger; user output belongs in commands/ or formatters/');
  });
});

describe('action gate', () => {
  const ACTION_GATE = 'packages/core/src/services/action-gate.ts';

  /** A `git push` or `gh` command anywhere but a `kind: 'push'` action request. */
  function pushOrGh(source) {
    const code = source.replace(/\bkind:\s*(['"`])push\1/g, '');
    return /\bgit\s+push\b/.test(code) || /(['"`])push\1/.test(code) || /(['"`])gh(\1|\s)/.test(code);
  }

  it('should catch the ways a module can build a push or gh command', () => {
    for (const source of ["['git', 'push', remote]", 'run(`git push ${remote}`)', "execFile('gh', ['pr'])", '"gh pr create"']) {
      assert.ok(pushOrGh(source), source);
    }
    for (const source of ["gate.request({ kind: 'push', command: gitPushCommand(r, b) })", 'items.push(x)', "'ghost'"]) {
      assert.ok(!pushOrGh(source), source);
    }
  });

  it('should build `git push` and `gh` commands only in the ActionGate module', () => {
    const offenders = trackedFiles('packages/*.ts', 'packages/*.tsx', 'desktop/src/*.ts', 'desktop/src/*.tsx')
      .filter((file) => file !== ACTION_GATE && !/\.test\.tsx?$/.test(file) && !file.includes('__fixtures__'))
      .filter((file) => pushOrGh(read(file)));

    assert.deepEqual(offenders, [], `orchestrator side effects that leave the run go through ActionGate (${ACTION_GATE})`);
  });
});

describe('docs match `concilium --help`', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'concilium-invariants-'));
  after(() => rmSync(sandbox, { recursive: true, force: true }));

  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const bin = join(ROOT, 'packages/cli/bin/concilium.ts');

  function help(...command) {
    return execFileSync(process.execPath, ['--import', tsx, bin, ...command, '--help'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: sandbox, XDG_CONFIG_HOME: sandbox, XDG_DATA_HOME: sandbox, XDG_CACHE_HOME: sandbox },
    });
  }

  function section(text, title) {
    const match = text.match(new RegExp(`^${title}:\\n((?:  .*\\n?)*)`, 'm'));
    return match ? match[1] : '';
  }

  function commandsIn(text) {
    return section(text, 'Commands').split('\n').map((line) => line.trim().split(/\s/)[0]).filter((c) => c && c !== 'help');
  }

  /** Flags from the left column of the Options section (descriptions and defaults are ignored). */
  function flagsIn(text) {
    const columns = section(text, 'Options')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-'))
      .map((line) => line.split(/\s{2,}/)[0]);
    return new Set(columns.flatMap((column) => column.match(/--?[a-zA-Z][\w-]*/g) ?? []));
  }

  /** command -> { flags, subcommands: sub -> flags } */
  const cli = new Map(
    commandsIn(help()).map((command) => {
      const text = help(command);
      const subcommands = new Map(commandsIn(text).map((sub) => [sub, flagsIn(help(command, sub))]));
      return [command, { flags: flagsIn(text), subcommands }];
    }),
  );

  /** Every `concilium <command> ...` invocation in the docs, cut at a pipe or comment. */
  function invocations(doc) {
    return [...read(doc).matchAll(/(?:^|[\s`|])concilium[ \t]+([a-z][\w-]*)([^\n`|#]*)/gm)].map((m) => ({
      command: m[1],
      args: m[2].trim().split(/\s+/).filter(Boolean),
    }));
  }

  it('should list every CLI command in each doc', () => {
    for (const doc of DOCS) {
      const documented = new Set(invocations(doc).map((i) => i.command));
      for (const command of cli.keys()) {
        assert.ok(documented.has(command), `${doc} does not mention \`concilium ${command}\``);
      }
    }
  });

  it('should only document commands, subcommands and flags the CLI has', () => {
    const problems = [];
    for (const doc of DOCS) {
      for (const { command, args } of invocations(doc)) {
        const spec = cli.get(command);
        if (!spec) {
          problems.push(`${doc}: unknown command \`concilium ${command}\``);
          continue;
        }
        let flags = spec.flags;
        if (spec.subcommands.size > 0 && args[0] && !/^[-[<]/.test(args[0])) {
          const subFlags = spec.subcommands.get(args[0]);
          if (!subFlags) problems.push(`${doc}: unknown subcommand \`concilium ${command} ${args[0]}\``);
          else flags = subFlags;
        }
        for (const flag of args.filter((a) => /^--?[a-zA-Z]/.test(a))) {
          if (!flags.has(flag.split('=')[0])) problems.push(`${doc}: \`concilium ${command}\` has no ${flag}`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it('should document every flag of every command in a CLI README options table', () => {
    const tableCells = read('packages/cli/README.md')
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => line.split('|')[1]);
    const documented = (flag) => tableCells.some((cell) => new RegExp(`${flag}(?![\\w-])`).test(cell));
    const missing = [];
    for (const [command, spec] of cli) {
      const all = [[command, spec.flags], ...[...spec.subcommands].map(([sub, flags]) => [`${command} ${sub}`, flags])];
      for (const [name, flags] of all) {
        for (const flag of flags) {
          if (flag === '-h' || flag === '--help') continue;
          if (!documented(flag)) missing.push(`concilium ${name} ${flag}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });
});
