# Agent Instructions for Concilium

This document provides guidelines for AI coding agents working on the Concilium codebase.

## Project Structure

```
concilium/
├── packages/
│   ├── core/             # @concilium/core — domain logic, ports, adapters
│   │   ├── src/
│   │   │   ├── domain/   # Agent, council, deliberation, run types & logic
│   │   │   ├── ports/    # Interfaces (AgentProvider, LlmGateway, etc.)
│   │   │   ├── adapters/ # OpenRouter, Claude, Codex, OpenCode, JSON storage
│   │   │   ├── services/ # DeliberationService, ConfigService, ModelDiscoveryService
│   │   │   └── shared/   # Logger, error types
│   │   └── package.json
│   └── cli/              # @concilium/cli — terminal interface
│       ├── bin/          # Entry point (concilium command)
│       ├── src/
│       │   ├── commands/ # run, history, config, models, gui
│       │   ├── ui/       # Ink (React) terminal components
│       │   ├── adapters/ # XDG paths, terminal secret store, callback event bridge
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
└── assets/               # Shared assets (logos, icons)
```

## Architecture

Concilium follows a **hexagonal (ports-and-adapters) architecture**:

- **`@concilium/core`** contains all domain logic, port interfaces, and shared adapters. It is framework-agnostic.
- **`@concilium/cli`** and **`desktop/`** are thin shells that provide their own adapter implementations for the port interfaces.

| Port Interface | CLI Adapter | Desktop Adapter |
|----------------|-------------|-----------------|
| `SecretStore` | `PlaintextSecretStore` / `TerminalSecretStore` | `ElectronSecretStore` (OS keychain) |
| `ConfigStore` | `JsonConfigStore` (XDG paths) | `JsonConfigStore` (Electron `userData`) |
| `RunRepository` | `JsonRunRepository` (XDG data dir) | `JsonRunRepository` (Electron `userData`) |
| `DeliberationEvents` | Callback event bridge / Ink reducer | IPC event bridge (`webContents.send`) |

When modifying deliberation logic, prompts, or ranking — work in `@concilium/core`. When modifying terminal output or CLI flags — work in `@concilium/cli`. When modifying the GUI — work in `desktop/`.

## Build Commands

All packages are managed as an npm workspace from the repo root.

```bash
npm install              # Install all workspace dependencies
```

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
npm run test -w concilium           # Run all tests
```

### Running Single Tests
```bash
# Run specific test file
npx vitest run packages/core/src/domain/deliberation/ranking.test.ts

# Run specific test pattern
npx vitest run -t "should parse step_start"

# Run tests for a specific directory
npx vitest run packages/core/src/
```

### Website
```bash
npm run dev -w concilium-website    # Development server
npm run build -w concilium-website  # Production build
npm run preview -w concilium-website # Preview production build
```

The website uses **Astro 5** with hybrid output (static pages + server-side API routes via Vercel adapter). The waitlist API route at `src/pages/api/waitlist.ts` runs server-side and posts to Supabase.

## Code Style Guidelines

### TypeScript
- **Strict mode enabled**: Always define types explicitly
- Use `type` for object shapes, `interface` for extensible contracts
- Prefer explicit return types for exported functions
- Use `const` assertions for literal types
- Enable `noImplicitAny` - never use implicit `any`

### Imports (Order Matters)
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
- **Utilities**: camelCase (`parseEventLine`, `createLogger`)
- **Types/Interfaces**: PascalCase (`AgentInstance`, `Stage1Result`)
- **Constants**: UPPER_SNAKE_CASE for true constants
- **CLI commands**: kebab-case for flags (`--juror-models`, `--stage1-only`)

### File Headers
Add MIT license header to new files:
```typescript
/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */
```

### Error Handling
- Use custom logger: `createLogger('module-name')`
- Never swallow errors - log and re-throw or handle gracefully
- Use early returns to reduce nesting
- Type guard with `instanceof Error` when catching
- Use custom error classes from `@concilium/core`: `ConciliumError`, `ConfigError`, `PipelineError`, `AgentError`

```typescript
import { createLogger } from '@concilium/core';
const log = createLogger('pipeline');

try {
  const result = await riskyOperation();
  return result;
} catch (err) {
  log.error('Operation failed:', err);
  throw err; // or return fallback
}
```

### Styling (Tailwind)
- Use semantic color tokens from theme (`--color-provider-opencode`, `--color-green-primary`)
- Prefer `bg-white/5` over arbitrary values
- Use `md:` prefixes for responsive breakpoints
- Group related classes: layout → spacing → colors → effects
- Website uses glassmorphism effects (`.glass`, `.glass-panel`)
- React islands use inline styles with hex values matching design tokens

### Testing (Vitest)
- Co-locate tests: `file.ts` → `file.test.ts`
- Use descriptive test names: `it('should parse step_start as status event')`
- Group related tests with `describe()` blocks
- Mock external dependencies
- Test edge cases and error conditions
- Core tests: `npm run test -w @concilium/core`
- Desktop tests: `npm run test -w concilium`

### React Components
- Use functional components with hooks
- Props interface: `Interface ComponentNameProps`
- Default exports for page components
- Named exports for utilities
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
- Always validate data before sending/receiving

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

### Type Guards
```typescript
function isValidResponse(obj: unknown): obj is ResponseType {
  return obj && typeof obj === 'object' && 'requiredField' in obj;
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
| `OPENROUTER_API_KEY` | core, cli, desktop | OpenRouter API key (highest priority) |
| `XDG_CONFIG_HOME` | cli | Override config directory |
| `XDG_DATA_HOME` | cli | Override data directory |
| `XDG_CACHE_HOME` | cli | Override cache directory |
| `SUPABASE_URL` | website | Supabase project URL (server-side only) |
| `SUPABASE_ANON_KEY` | website | Supabase anon key (server-side only) |

## Pre-Submission Checklist
- [ ] Code follows TypeScript strict mode
- [ ] ESLint passes (`npm run lint -w concilium`)
- [ ] Tests pass (`npm run test -w @concilium/core`)
- [ ] License header added to new files
- [ ] No `console.log` in core/cli — use logger instead
- [ ] Error handling in place
- [ ] Types explicitly defined
- [ ] Changes in core don't break cli or desktop

## License
All code must be compatible with the MIT License.
