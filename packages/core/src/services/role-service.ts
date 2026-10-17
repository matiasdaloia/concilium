/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { FACTORY_CONFIG, parseFactoryRoles, type RoleSettings } from '../domain/roles/roles.js';

/**
 * The roles in the nearest `.concilium/factory.yaml` from `dir` up to its repo root (the first dir holding `.git`),
 * read now, so an edit applies to the next run. No file: no roles. Throws a `RolesValidationError` naming the
 * file's path when it is invalid.
 */
export async function readRepoRoles(dir: string): Promise<{ path: string | null; roles: RoleSettings }> {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const path = join(at, FACTORY_CONFIG);
    if (existsSync(path)) {
      return { path, roles: parseFactoryRoles(await readFile(path, 'utf8'), path) };
    }
    if (existsSync(join(at, '.git')) || dirname(at) === at) return { path: null, roles: {} };
  }
}
