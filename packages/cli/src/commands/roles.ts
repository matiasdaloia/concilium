/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  createConciliumRuntime,
  FACTORY_CONFIG,
  JsonConfigStore,
  JsonRunRepository,
  parseRoleFlags,
  PlaintextSecretStore,
  roleWarnings,
} from '@concilium/core';
import { getConfigDir, getDataDir } from '../adapters/xdg-paths.js';
import { roleRows, tableLines } from '../formatters/roles.js';

/** Collects a repeatable option. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerRolesCommand(program: Command): void {
  program
    .command('roles')
    .description('Show who plays each role and where it was set')
    .option('--cwd <path>', `Directory of the repo whose ${FACTORY_CONFIG} applies`, process.cwd())
    .option('--role <role=members>', 'Set a role for this preview, as `code --role` does (repeatable)', collect)
    .option('--json', 'Output as JSON')
    .action(async (opts: { cwd: string; role?: string[]; json?: boolean }) => {
      const runtime = createConciliumRuntime({
        secretStore: new PlaintextSecretStore(),
        configStore: new JsonConfigStore(getConfigDir()),
        runRepository: new JsonRunRepository(getDataDir()),
      });
      let map: Awaited<ReturnType<typeof runtime.resolveRoleMap>>;
      try {
        map = await runtime.resolveRoleMap({ repoDir: resolve(opts.cwd), flags: parseRoleFlags(opts.role ?? []) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(opts.json ? JSON.stringify({ error: message }) : `Error: ${message}`);
        process.exit(1);
      }
      const warnings = roleWarnings(map.roles);

      if (opts.json) {
        console.log(JSON.stringify({ ...map, warnings }, null, 2));
        return;
      }
      console.log();
      for (const line of tableLines(roleRows(map.roles))) console.log(line);
      console.log(`\n  Sources, highest first: flag, env (jurors and chairman only), repo (${map.factoryPath ?? `no ${FACTORY_CONFIG}`}), saved (concilium config set), default.`);
      for (const warning of warnings) console.log(`  Warning: ${warning}`);
      for (const note of map.notes) console.log(`  Note: ${note}`);
      console.log();
    });
}
