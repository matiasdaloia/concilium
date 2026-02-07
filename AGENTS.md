# Agent Instructions for Concilium

This document provides guidelines for AI coding agents working on the Concilium codebase.

## Project Structure

```
llm-council/
├── desktop/          # Electron desktop app
│   ├── src/
│   │   ├── main/     # Node.js main process (services/, ipc.ts, main.ts)
│   │   ├── preload/  # Preload scripts
│   │   └── renderer/ # React frontend (screens/, components/, hooks/)
│   └── package.json
├── website/          # Astro marketing website
│   ├── src/
│   │   ├── sections/ # Page sections
│   │   ├── islands/  # Interactive React components
│   │   └── layouts/
│   └── package.json
└── assets/           # Shared assets
```

## Build Commands

### Desktop App
```bash
cd desktop
npm install
npm run start        # Development mode
npm run package      # Package app for distribution
npm run make         # Create distributables
npm run lint         # Run ESLint
npm run test         # Run all tests
npm run test:watch   # Run tests in watch mode
```

### Running Single Tests
```bash
# Run specific test file
npx vitest run src/main/services/parsers.test.ts

# Run specific test pattern
npx vitest run -t "should parse step_start"

# Run tests for a specific directory
npx vitest run src/main/services/
```

### Website
```bash
cd website
npm install
npm run dev          # Development server
npm run build        # Production build
npm run preview      # Preview production build
```

## Code Style Guidelines

### TypeScript
- **Strict mode enabled**: Always define types explicitly
- Use `type` for object shapes, `interface` for extensible contracts
- Prefer explicit return types for exported functions
- Use `const` assertions for literal types
- Enable `noImplicitAny` - never use implicit `any`

### Imports (Order Matters)
1. External libraries (React, Electron, etc.)
2. Type-only imports: `import type { ... }`
3. Internal absolute imports
4. Relative imports (sibling files first, then parent dirs)

```typescript
import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { AgentInstance } from '../types';
import ModelCombobox from './ModelCombobox';
```

### Naming Conventions
- **Components**: PascalCase (`AgentCard.tsx`, `HomeScreen.tsx`)
- **Hooks**: camelCase starting with `use` (`useCouncilRun.ts`)
- **Utilities**: camelCase (`parseEventLine`, `createLogger`)
- **Types/Interfaces**: PascalCase (`AgentInstance`, `Stage1Result`)
- **Constants**: UPPER_SNAKE_CASE for true constants

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

```typescript
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
- Use semantic color tokens from theme (`--color-provider-opencode`)
- Prefer `bg-white/5` over arbitrary values
- Use `md:` prefixes for responsive breakpoints
- Group related classes: layout → spacing → colors → effects

### Testing (Vitest)
- Co-locate tests: `file.ts` → `file.test.ts`
- Use descriptive test names: `it('should parse step_start as status event')`
- Group related tests with `describe()` blocks
- Mock external dependencies
- Test edge cases and error conditions

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

### IPC Communication
- Main process: use `ipcMain.handle()` for async operations
- Renderer: use `window.electronAPI` (exposed via preload)
- Always validate data before sending/receiving

## Common Patterns

### Logger Usage
```typescript
import { createLogger } from './logger';
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

## Pre-Submission Checklist
- [ ] Code follows TypeScript strict mode
- [ ] ESLint passes (`npm run lint`)
- [ ] Tests pass (`npm run test`)
- [ ] License header added to new files
- [ ] No `console.log` - use logger instead
- [ ] Error handling in place
- [ ] Types explicitly defined

## License
All code must be compatible with the MIT License.
