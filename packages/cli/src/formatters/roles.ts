/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { ROLE_NAMES, type RoleMap } from '@concilium/core';

/** What each role keyword stands for. */
const KEYWORDS: Record<string, string> = {
  'same-as-implementer': 'one per implementer family, the first candidate of each',
  auto: 'a usable CLI of another family than the candidates it reads',
  winner: "the base's CLI and model",
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
      const meaning = typeof value === 'string' && KEYWORDS[value] ? ` (${KEYWORDS[value]})` : '';
      return [[role, `${members || '(none)'}${meaning}`, source]];
    }),
  ];
}

/** Rows padded into aligned lines. */
export function tableLines(rows: string[][], indent = '  '): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return rows.map((row) => `${indent}${row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd()}`);
}
