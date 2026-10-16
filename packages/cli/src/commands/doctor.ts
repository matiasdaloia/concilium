/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { Command } from 'commander';
import { createHeadlessCliDrivers } from '@concilium/core';

const TERMS_DOC = 'https://github.com/matiasdaloia/concilium/blob/main/docs/research/subscription-tos.md';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check installed agent CLIs and how they sign in')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const clis = await Promise.all(
        createHeadlessCliDrivers().map(async (driver) => ({ id: driver.id, ...(await driver.detect()) })),
      );

      if (opts.json) {
        console.log(JSON.stringify({ clis, termsOfUse: TERMS_DOC }, null, 2));
        return;
      }

      const rows = [
        ['CLI', 'Installed', 'Version', 'Auth', 'Notes'],
        ...clis.map((c) => [c.id, c.installed ? 'yes' : 'no', c.version ?? '-', c.installed ? (c.auth ?? 'unknown') : '-', c.notes ?? '']),
      ];
      const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
      console.log();
      for (const row of rows) {
        console.log(`  ${row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd()}`);
      }
      console.log(`\n  Terms of use and auth notes: ${TERMS_DOC}\n`);
    });
}
