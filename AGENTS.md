# Agent Instructions for Concilium

This document provides guidelines for AI coding agents working on the Concilium codebase.

Rules are split in two. **Enforced rules** are checked by a command, so a change that breaks them fails `npm test`, the typecheck or lint. **Guidance** is the preferred style; no tool checks it. When the two disagree with the code, the enforced checks win.

## Project Structure

```
concilium/
├── packages/
│   ├── core/             # @concilium/core — domain logic, ports, adapters
│   │   ├── src/
│   │   │   ├── domain/   # Agent, council, deliberation, run types & logic
│   │   │   ├── ports/    # Interfaces (AgentProvider, LlmGateway, etc.)
│   │   │   ├── adapters/ # OpenRouter, Claude, Codex, OpenCode, JSON storage
│   │   │   ├── services/ # createConciliumRuntime, DeliberationService, ConfigService, ModelDiscoveryService
│   │   │   └── shared/   # Logger
│   │   └── package.json
│   └── cli/              # @concilium/cli — terminal interface
│       ├── bin/          # Entry point (concilium command)
│       ├── src/
│       │   ├── commands/ # run, history, config, models
│       │   ├── ui/       # Ink (React) terminal components
│       │   ├── adapters/ # XDG paths, callback event bridge
│       │   └── formatters/
│       └── package.json
├── desktop/              # Electron desktop application
│   ├── src/
│   │   ├── main/         # Main process + Electron-specific adapters
│   │   ├── preload/      # Preload scripts
│   │   └── renderer/     # React frontend (screens/, components/, hooks/)
│   └── package.json
├── website/              # Astro marketing website
│   ├── src/
│   │   ├── sections/     # Page sections (Hero, CLI, CloudWaitlist, etc.)
│   │   ├── islands/      # Interactive React components (WaitlistForm, PipelineDemo, etc.)
│   │   ├── components/   # Reusable Astro components (Button, SectionHeader, etc.)
│   │   ├── pages/        # Routes (index.astro, api/waitlist.ts)
│   │   ├── layouts/      # BaseLayout
│   │   └── styles/       # Tailwind CSS + design tokens
│   └── package.json
├── scripts/              # repo-invariants.test.mjs (checks the enforced rules below)
└── assets/               # Shared assets (logos, icons)
```

## Architecture

Concilium follows a **hexagonal (ports-and-adapters) architecture**:

- **`@concilium/core`** contains all domain logic, port interfaces, and shared adapters. It is framework-agnostic.
- **`@concilium/cli`** and **`desktop/`** are thin shells. Each supplies its own adapters for the ports below and builds everything else through `createConciliumRuntime(adapters)` in core.

| Port Interface | CLI Adapter | Desktop Adapter |
|----------------|-------------|-----------------|
| `SecretStore` | `PlaintextSecretStore` | `ElectronSecretStore` (OS keychain) |
| `ConfigStore` | `JsonConfigStore` (XDG paths) | `JsonConfigStore` (Electron `userData`) |
| `RunRepository` | `JsonRunRepository` (XDG data dir) | `JsonRunRepository` (Electron `userData`) |
| `DeliberationEvents` | Callback event bridge / Ink reducer | IPC event bridge (`webContents.send`) |

Agent providers are listed once, in the `PROVIDERS` registry (`packages/core/src/domain/agent/providers.ts`), with a factory per id in `services/create-concilium.ts`.

When modifying deliberation logic, prompts, or ranking — work in `@concilium/core`. When modifying terminal output or CLI flags — work in `@concilium/cli`. When modifying the GUI — work in `desktop/`.

## Build Commands

All packages are managed as an npm workspace from the repo root. Node 22 or later.

### Whole repo (what CI runs)
```bash
npm ci                   # Clean install from the lockfile
npm run build            # Build core, then cli
npm run typecheck        # core + cli (including tests) and desktop
npm test                 # vitest in core, cli and desktop, then the repo invariants
npm run lint -w concilium   # ESLint (desktop only)
```

The full offline verification procedure and the feature-to-test map live in `.claude/skills/verify-concilium/SKILL.md`.

### Core
```bash
npm run build -w @concilium/core    # Build core library
npm run test -w @concilium/core     # Run core tests (vitest)
```

### CLI
```bash
npm run dev -w @concilium/cli       # Dev mode with tsx
npm run build -w @concilium/cli     # Build CLI
npx concilium run "prompt"          # Run via workspace
npx concilium config show           # Show config
npx concilium models                # Discover models
npx concilium history               # List past runs
```

### Desktop App
```bash
npm run start -w concilium          # Development mode
npm run package -w concilium        # Package app for distribution
npm run make -w concilium           # Create distributables
npm run lint -w concilium           # Run ESLint
npm run test -w concilium           # Run desktop tests
```

### Running Single Tests
```bash
# Run specific test file
npx vitest run packages/core/src/domain/deliberation/ranking.test.ts

# Run specific test pattern
npx vitest run -t "should read the numbered list after FINAL RANKING"

# Run tests for a specific directory
npx vitest run packages/core/src/

# Run only the repo invariants (needs a built core)
npm run test:repo
```

### Website
```bash
npm run dev -w concilium-website    # Development server
npm run build -w concilium-website  # Production build
npm run preview -w concilium-website # Preview production build
```

The website uses **Astro 5** with static output and the Vercel adapter. The waitlist API route at `src/pages/api/waitlist.ts` opts out of prerendering (`prerender = false`), runs server-side and posts to Supabase.

## Enforced rules

Each rule names the check that enforces it. `scripts/repo-invariants.test.mjs` runs as part of `npm test`.

| Rule | Checked by |
|------|------------|
| TypeScript strict mode and `noImplicitAny` in core, cli and desktop | `npm run typecheck` (`tsconfig.base.json`, `desktop/tsconfig.json`) |
| New `.ts`/`.tsx` files under `packages/` and `desktop/` carry the MIT header below | repo invariants: the count of files without it may only go down (`MISSING_HEADER_BASELINE`). When you add headers to old files, lower the baseline. |
| `packages/core` imports only its own files, Node builtins and the dependencies in its `package.json`. It never imports the CLI, the desktop app or Electron. | repo invariants |
| Core code logs through `createLogger`. No `console.*` in `packages/core/src` outside `shared/logger.ts`. | repo invariants |
| CLI code calls `console.*` only in `src/commands/` and `src/formatters/` | repo invariants |
| The logger writes every level to stderr, so stdout carries only command output (`run --json`). | `packages/cli/bin/concilium.test.ts` |
| Every command the docs (`AGENTS.md`, `README.md`, `packages/cli/README.md`) show exists in `concilium --help`, with the flags they show. Every command appears in each doc. Every flag appears in an options table in `packages/cli/README.md`. | repo invariants |
| The CLI `--help` and `run --help` text is stable | snapshots in `packages/cli/bin/__snapshots__/` (update with `npx vitest run packages/cli -u` and review the diff) |
| Desktop lint | `npm run lint -w concilium` |

### File header

```typescript
/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */
```

### Console output

- **Core:** never call `console` directly; use `createLogger('module-name')`.
- **CLI:** command output (results, tables, JSON, error messages for the user) uses `console.log` for stdout and `console.error` for stderr in `src/commands/` and `src/formatters/`. Diagnostics go through the core logger. Keep stdout parseable when `--json` is set.

## Guidance

Not checked by any tool. Follow it for new code; don't rewrite existing code only to match it.

### TypeScript
- Use `type` for object shapes, `interface` for extensible contracts
- Prefer explicit return types for exported functions
- Use `const` assertions for literal types

### Imports (order)
1. Node.js builtins (`node:fs`, `node:path`)
2. External libraries (React, Electron, Commander, etc.)
3. Type-only imports: `import type { ... }`
4. Internal package imports (`@concilium/core`)
5. Relative imports (sibling files first, then parent dirs)

```typescript
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import type { Command } from 'commander';
import { DeliberationService, type AgentProvider } from '@concilium/core';
import { getConfigDir } from '../adapters/xdg-paths.js';
```

### Naming Conventions
- **Components**: PascalCase (`AgentCard.tsx`, `HomeScreen.tsx`)
- **Hooks**: camelCase starting with `use` (`useCouncilRun.ts`)
- **Utilities**: camelCase (`parseClaudeEventLine`, `createLogger`)
- **Types/Interfaces**: PascalCase (`AgentInstance`, `Stage1Result`)
- **Constants**: UPPER_SNAKE_CASE for true constants
- **CLI flags**: kebab-case (`--juror-models`, `--no-save`)

### Error Handling
- Don't swallow errors: log and re-throw, or handle them and say so in the result. (Known exception today: `ConfigService.resolve` drops a decrypt error and treats the key as unset.)
- Use early returns to reduce nesting
- Type guard with `instanceof Error` when catching

```typescript
import { createLogger } from '@concilium/core';
const log = createLogger('pipeline');

try {
  return await riskyOperation();
} catch (err) {
  log.error('Operation failed:', err instanceof Error ? err.message : err);
  throw err;
}
```

### Testing (Vitest)
- Co-locate tests: `file.ts` → `file.test.ts`; recorded fixtures go in `__fixtures__/` next to the test
- Use descriptive test names: `it('should parse step_start as status event')`
- Assert on behavior (returned records, events, files written, CLI output), not on private helpers
- Never touch the network, real agent binaries or `~`: use fakes behind the ports, `mkdtemp` directories and `HOME`/`XDG_*` overrides
- A test that exposes a bug you are not fixing stays in the suite as `it.skip` with a `BUG:` comment

### Styling (Tailwind)
- Use semantic color tokens from theme (`--color-provider-opencode`, `--color-green-primary`)
- Prefer `bg-white/5` over arbitrary values
- Use `md:` prefixes for responsive breakpoints
- Group related classes: layout → spacing → colors → effects
- Website uses glassmorphism effects (`.glass`, `.glass-panel`)
- React islands use inline styles with hex values matching design tokens

### React Components
- Use functional components with hooks
- Props type: `interface ComponentNameProps`
- Default exports for page components, named exports for utilities
- Destructure props in function parameters

```typescript
interface AgentCardProps {
  instance: AgentInstance;
  onUpdate: (instance: AgentInstance) => void;
}

export default function AgentCard({ instance, onUpdate }: AgentCardProps) {
  // component logic
}
```

### IPC Communication (Desktop only)
- Main process: use `ipcMain.handle()` for async operations
- Renderer: use `window.electronAPI` (exposed via preload)
- Validate data that crosses the IPC boundary

### Website Islands
- Interactive React components go in `website/src/islands/`
- Use `client:visible` for lazy hydration (most components)
- Use `client:load` only for above-the-fold components (Hero3D)
- Static sections go in `website/src/sections/` as `.astro` files

## Common Patterns

### Logger Usage
```typescript
import { createLogger } from '@concilium/core';
const log = createLogger('module-name');
log.info('Message');
log.error('Error:', error);
```

Level: `LOG_LEVEL` env var, else `info` when `NODE_ENV=production`, else `debug`. `setLogLevel()` overrides it (the CLI uses it for `--verbose` and `--quiet`).

### Type Guards
```typescript
function isValidResponse(obj: unknown): obj is ResponseType {
  return typeof obj === 'object' && obj !== null && 'requiredField' in obj;
}
```

### Tailwind Color Variables
```typescript
const PROVIDERS = [
  { id: 'opencode', color: 'var(--color-provider-opencode)' },
  { id: 'codex', color: 'var(--color-provider-codex)' },
  { id: 'claude', color: 'var(--color-provider-claude)' },
];
```

### CLI Command Registration
```typescript
export function registerFooCommand(program: Command): void {
  program
    .command('foo')
    .description('Description of the command')
    .argument('[arg]', 'Argument description')
    .option('--flag <value>', 'Flag description')
    .action(async (arg: string, opts: FooOptions) => {
      // command logic
    });
}
```

### XDG Paths (CLI)
```typescript
import { getConfigDir, getDataDir, getCacheDir } from '../adapters/xdg-paths.js';
// Config:  ~/.config/concilium/   (or $XDG_CONFIG_HOME/concilium/)
// Data:    ~/.local/share/concilium/ (or $XDG_DATA_HOME/concilium/)
// Cache:   ~/.cache/concilium/    (or $XDG_CACHE_HOME/concilium/)
```

## Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | core, cli, desktop | OpenRouter API key. Beats the saved key. |
| `OPENROUTER_API_URL` | core, cli, desktop | Chat completions endpoint. Default `https://openrouter.ai/api/v1/chat/completions`. |
| `COUNCIL_MODELS` | core, cli, desktop | Comma-separated juror models. Beats the saved jurors. |
| `CHAIRMAN_MODEL` | core, cli, desktop | Chairman model. Beats the saved chairman. |
| `LOG_LEVEL` | core | `debug`, `info`, `warn` or `error` |
| `XDG_CONFIG_HOME` | cli | Override config directory |
| `XDG_DATA_HOME` | cli | Override data directory |
| `XDG_CACHE_HOME` | cli | Override cache directory |
| `SUPABASE_URL` | website | Supabase project URL (server-side only) |
| `SUPABASE_ANON_KEY` | website | Supabase anon key (server-side only) |

Config precedence, highest first, per setting: explicit overrides (`run --juror-models`/`--chairman`, the `deliberate()` options `councilModels`/`chairmanModel`/`apiKey`), then environment variable, then saved config (`concilium config set ...`, which merges into the saved settings), then built-in default. `ConfigService.resolve(overrides)` implements it, `createConciliumRuntime` resolves it once per deliberation and passes it to `DeliberationService`, and `packages/core/src/services/config-service.test.ts` pins it.

## Pre-Submission Checklist
- [ ] Verified offline per `.claude/skills/verify-concilium/SKILL.md`: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint -w concilium` and `node packages/cli/dist/bin/concilium.js --help` all exit 0
- [ ] New behavior has a test, and a fixed bug has a test that failed before the fix
- [ ] If `npm run test:repo` asks you to lower `MISSING_HEADER_BASELINE`, lower it
- [ ] Changes in core don't break cli or desktop (the typecheck covers all three)

## License
All code must be compatible with the MIT License.
