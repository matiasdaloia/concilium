/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */
import js from '@eslint/js';
import { createNodeResolver, flatConfigs as importX } from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.vite/', 'out/', 'dist/'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      importX.recommended,
      importX.electron,
      importX.typescript,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Was in @typescript-eslint v5 `recommended`; kept to match the old config.
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
    settings: {
      'import-x/resolver-next': [
        createNodeResolver({ extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'] }),
      ],
    },
  },
);
