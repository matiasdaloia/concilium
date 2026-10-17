/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { ROLE_KEYWORDS, ROLE_NAMES, type RoleMap, type RoleName } from '@concilium/core';

/** What each role's keyword stands for. */
const KEYWORDS: Partial<Record<RoleName, string>> = {
  adversary: 'one per implementer family, the first candidate of each',
  judge: 'a usable CLI of another family than the candidates it reads',
  integrator: "the base's CLI and model",
  verifier: 'a usable CLI of another family than the authors, else a flagged same-family one',
};

/** A `Role`, `Members`, `Source` table of the roles in `roles`, in role order. */
export function roleRows(roles: Partial<RoleMap>): string[][] {
  return [
    ['Role', 'Members', 'Source'],
    ...ROLE_NAMES.flatMap((role) => {
      const resolved = roles[role];
      if (!resolved) return [];
      const { value, source } = resolved;
      const members = Array.isArray(value) ? value.join(', ') : value;
      const keyword = (ROLE_KEYWORDS as Partial<Record<RoleName, string>>)[role];
      const meaning = value === keyword && KEYWORDS[role] ? ` (${KEYWORDS[role]})` : '';
      return [[role, `${members || '(none)'}${meaning}`, source]];
    }),
  ];
}

/** Rows padded into aligned lines. */
export function tableLines(rows: string[][], indent = '  '): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return rows.map((row) => `${indent}${row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd()}`);
}
