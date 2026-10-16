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
│   │   │   ├── ports/    # Interfaces (HeadlessCliDriver, LlmGateway, etc.)
│   │   │   ├── adapters/ # Agent CLI drivers, CLI council gateway, git worktrees, OpenRouter, JSON storage
│   │   │   ├── services/ # createConciliumRuntime, DeliberationService, ConfigService, ModelDiscoveryService
│   │   │   └── shared/   # Logger
│   │   └── package.json
│   └── cli/              # @concilium/cli — terminal interface
│       ├── bin/          # Entry point (concilium command)
│       ├── src/
│       │   ├── commands/ # run, code, history, config, models, doctor, gc
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

Agent providers (`claude`, `codex`, `gemini`, `opencode`) are listed once, in the `PROVIDERS` registry (`packages/core/src/domain/agent/providers.ts`), with their model family and model list, and a headless CLI driver per id in `adapters/cli/cli-drivers.ts`.

Every stage runs through the `HeadlessCliDriver` port (`packages/core/src/ports/headless-cli-driver.ts`), under the user's own CLI logins, with no API key: one driver per installed agent CLI (`adapters/cli/cli-drivers.ts`), a versioned `Brief` in and a versioned `Report` out (`domain/driver/`), processes spawned through `adapters/cli/subprocess.ts`, and `FakeCliDriver` for tests. Drivers only use the CLI's own login and never read credential files (see `docs/research/subscription-tos.md`). `detect()` works for every CLI and is used by `concilium doctor`. `run()` works for Claude Code (`adapters/cli/claude-code.ts`: `claude -p --output-format=stream-json`, plan briefs in plan mode, only the tools of the brief's allowed actions) and Codex (`adapters/cli/codex.ts`: `codex exec --json`, plan briefs in the read-only sandbox, code briefs in workspace-write, network only when allowed, no approvals) and Gemini CLI (`adapters/cli/gemini.ts`: `gemini --output-format=stream-json --prompt=...`, falling back to `json` on versions without stream-json; plan briefs in the `default` approval mode, which headless leaves with only read-only tools, code briefs in `auto_edit`, never `yolo`; its fixtures follow the documented format but are not recorded) and OpenCode (`adapters/cli/opencode.ts`: `opencode run --format=json`, plan briefs with the `plan` agent, code briefs with `build`, never `--auto`; `OPENCODE_PERMISSION` denies the tools of actions the brief does not allow, and bash for plan briefs, since the `plan` agent allows it; its fixtures follow the emitter in the installed opencode 1.18.21 but are not recorded; never use it with a Claude subscription login).

The plan council uses the drivers in all three stages. Stage 1 agents (`domain/agent/agent-executor.ts`) get a read-only plan brief (read and network actions) in the run's `cwd`. Without `--agents` (CLI), `agents` (`deliberate()`) or saved agents (desktop), `runtime.defaultAgentInstances()` picks one agent per CLI whose `detect()` says installed and signed in (`subscription` or `api-key`) with no `warning`, in registry order, and rejects with `NO_AGENT_CLI_MESSAGE` (pointing to `concilium doctor` and `docs/research/subscription-tos.md`) when none qualifies. Jurors and the chairman are council member specs (`domain/council/council-members.ts`): `cli[:model]` (`claude`, `codex:gpt-5.2`, `opencode:openai/gpt-5.2`) runs that CLI through `CliCouncilGateway` (`adapters/cli/cli-council-gateway.ts`) on a read-only plan brief in a fresh temp dir holding only the prompt file; any other id is an OpenRouter model, sent to `OpenRouterGateway` only when an API key is configured (otherwise it is skipped with a note). `resolveCouncil` fills missing jurors with every installed, signed-in CLI with a known family (OpenCode only as a last resort) and a missing chairman with the usable CLI whose family holds the fewest juror seats; `createConciliumRuntime` runs `detect()` only when it has to fill one in. Tests swap drivers for `FakeCliDriver`s (`runtime.drivers.set(...)`, or `respond(brief)` for fakes that read their prompt).

Candidate worktrees (M2.1) go through the `WorkspaceManager` port (`packages/core/src/ports/workspace.ts`) and its adapter `GitWorktreeWorkspace` (`adapters/git-worktree-workspace.ts`). `startRun` pins `baseSha = HEAD` and refuses a dirty tree unless `includeDirty`, which commits the working tree through a temp index to the scratch ref `refs/concilium/<run-id>/snapshot` and leaves the user's index and checkout alone. `create` adds a worktree at `<root>/<repo-hash>/<run-id>/<candidate-id>` on branch `concilium/<run-id>/<candidate-id>` (`integrationBranch(runId)` is `concilium/<run-id>/integration`). The root is a constructor option; the CLI passes `$XDG_CACHE_HOME/concilium/worktrees` (`getWorktreeRoot()`), never a dir inside the target repo. A run manifest (`<run-id>/manifest.json`) is written before any worktree and records the base, the candidates and the owner process. Every operation is idempotent and repairs what a crash leaves (deleted dirs, stale manifest entries, half-added worktrees) from the manifest, `git worktree list --porcelain` and `git worktree prune`. `gc` collects runs that are finished or whose owner process is gone, deletes only `refs/heads/concilium/<run-id>/*` and `refs/concilium/<run-id>/*`, and keeps the integration branch unless `includeIntegration`. `commit` commits what a candidate left in its worktree on its branch as `concilium` (`--no-verify`, ignored files left out), and `diffStat` counts the branch's commits, files and lines against the base. Tests run on real temp repos (`git-worktree-workspace.test.ts`, `packages/cli/src/commands/gc.test.ts`).

`concilium code` (M2.2) is `runCodeCandidates` (`packages/core/src/services/code-service.ts`): it pins the base with `startRun`, creates one worktree per agent (candidate id = provider, `claude-2` for a second one), runs every driver in parallel on a `codeBrief` (`mode: 'code'`, `read`/`write`/`shell`, `cwd` = the worktree; each driver keeps what its CLI can do safely), then `commit`s and `diffStat`s each candidate, even a failed one, and calls `finishRun` so `gc` can collect it. A candidate that fails (driver error, missing driver, worktree error) is recorded with `status: 'error'` and never stops the others. The worktrees stay for inspection. Before the worktrees (M3.1, M3.2), the run is framed in `domain/code-council/`: the task type is `--type` (`type` input) or `classifyTask`'s keyword guess (default `feature`), recorded with its reason as `taskType`; `PLAYBOOKS` (`playbooks.ts`) holds per type the ordered steps, the verification expectations and 3 to 6 default rubric criteria (`name`, `description`, `weight`, `evidence`: `gate`/`adversarial`/`judgment`). The first agent's CLI gets one read-only `CliCouncilGateway` run on `rubricPrompt` to tailor the criteria; a failed run or an answer `parseRubricAnswer` rejects falls back to the playbook defaults with a `note`. `freezeRubric` validates 3 to 6 criteria and stamps `frozenAt` and a sha256 (`rubricHash`) into the record's `rubric`, and `framedTask` puts the playbook into every candidate brief. Candidates never see the rubric: `framedTask` and `codeBrief` take only the task type, and the rubric goes only to the record, `onFramed` and the CLI output. Tests: `playbooks.test.ts`, `rubric.test.ts`, `code-service.test.ts` (per-type brief snapshots). The CLI saves the `CodeRunRecord` with `JsonCodeRunStore` to `<dataDir>/runs/<run-id>/run.json`, a directory the plan-run listing ignores. After the candidates (M4.1), unless `--no-verify` (`verify: true` input; core defaults to off), `verifyCandidates` (`services/verification-service.ts`) creates the scratch lane `base` with `create` (branch `concilium/<run-id>/base`, collected by `gc`), decides the gates from it with `GateRunner.plan` (`adapters/gate-runner.ts`; `planGates` in `domain/verification/gates.ts`: `.concilium/verify.yaml` `gates`/`install` replace detection; detection is `package.json` scripts `typecheck`/`lint`/`test`, the same Makefile targets, `go vet`/`go test`, `pytest`, `cargo test`; `npm ci` when `package-lock.json` exists and `node_modules` does not), runs them once on the base and then on each candidate head, one lane at a time (`/bin/sh -c`, scrubbed env via `gateEnv`, 10-minute `GATE_TIMEOUT_MS`, the last `OUTPUT_LIMIT` characters kept, each result carrying the SHA it ran at), and `judgeGates` keeps only new failures against the base (`baseline-failure` otherwise). Tier 0 is `checkIntegrity` (`domain/verification/integrity.ts`) on `git diff -M base head`: deleted or moved test files, new skip/only markers and lowered coverage thresholds `disqualify`; gate config edits (lint, tsconfig, test runner, CI, `.concilium/`, gate scripts in `package.json`) and added dependencies are `penalty`, each with its hunk as `evidence`. The result is `verification` on the record (plan, baseline) and on each candidate (`PASS`/`ISSUES`, `disqualified`, `newFailures`, `penalties`). Then (M4.2), unless `--no-adversarial` (`adversarial: true` input; core defaults to off; skipped with a reason without the gates, with fewer than 2 candidates with a head, or with no test gate), `runAdversarialRound` (`services/adversarial-service.ts`) runs Tier 2: one adversary per candidate model family (`getProviderInfo(provider).family`, the provider id for OpenCode), the first candidate of that family's CLI and model, on an `adversaryBrief` (`domain/verification/adversarial.ts`; `mode: 'code'`) in its own worktree `adv-<family>` from the base, with the other families' `git diff base head` as read-only patch files in a temp dir (listed in the brief's constraints, removed after), in parallel, with the candidate timeout. It lists its tests in `concilium-adversarial.json` (`{"tests": [{"files": [...], "specClause": "..."}]}`); `parseAdversarialManifest` keeps existing relative test files with a clause, at most `MAX_TESTS_PER_ADVERSARY` (5), and its branch is committed. Each test (`<family>-<n>`) runs under the plan's test gate (`testGate`) through `GateRunner.runStep` on the `base` lane and every candidate worktree, one at a time: its files are copied in and restored after, so no branch changes; a lane whose own test gate did not pass is not run and gets `error`. `classifyTest` applies the validity rule (`evidence` only when it fails on the base and passes on a candidate of another family than its author, `own-family-only` when it passes only on its author's family, `quarantined`, `vacuous` for a bugfix, `regression-guard` otherwise, `unrunnable`), and `survival` counts per candidate the `evidence` and `regression-guard` tests of other families. The result is `adversarial` on the record (`adversaries`, `tests`, `matrix`, `survival`, `runs`). Last (M4.3), `rankRun` (`services/ranking-service.ts`) gives each candidate a `report` (`reportCandidate`; `CandidateReport` in `domain/code-council/ranking.ts`: `PASS`/`ISSUES`/`BLOCKED`, `branch`, `baseSha`, `headSha`, `evidence` of kind `agent`/`gate`/`integrity`/`survival`/`playbook`, `reason`; `BLOCKED` = no head or no change; a final message that does not acknowledge every playbook step, per `missingPlaybookSteps` in `framing.ts`, is an `ISSUES` finding) and ranks them with the pure `rankCandidates`: `compareEvidence` puts blocked then disqualified last, then fewer new gate failures, higher survival rate (none counted = 1), fewer penalties. Unless `--no-judge` (`judge: true` input; core defaults to off), each exact tie group of candidates that can win (`tieGroups`, `contends`) goes to `judgeTie`: BLOCKED when `rubricHash(criteria)` no longer equals the frozen `sha256`; `pickJudge` (`domain/code-council/judging.ts`) takes the first installed, signed-in CLI in registry order whose family wrote none of the tied candidates, and only when there is none the first usable one, flagged `sameFamily: true` with `sameFamilyReason` on the `Judgment`, a `judge` evidence line (`ok: true`) in each tied report and a `Warning:` line in the CLI summary; one read-only `CliCouncilGateway` run on `judgePrompt` (blind letters, diffs capped at `JUDGE_DIFF_LIMIT`, evidence without the agent line, the frozen rubric, no example ordering); `parseJudgeAnswer` requires one 0 to 10 score with a reason per candidate and criterion, else BLOCKED. A PASS `Judgment`'s weighted totals order only its tie group. The result is `ranking` on the record (`order` with `rank`, `key`, `judgeTotal`; `winner` or null with `reason`; `judgments`). No sandbox or synthesis yet (M5). Tests: `ranking.test.ts`, `judging.test.ts`, `framing.test.ts`, `code-service.test.ts` (`runCodeCandidates ranking`), `code.test.ts`. Tests: `gates.test.ts`, `gate-runner.test.ts` (real temp repos), `code-service.test.ts`, `code.test.ts`. Tests: `code-service.test.ts` (`FakeCliDriver`s that write files in their cwd, real temp repos) and `packages/cli/src/commands/code.test.ts` (fake `claude`/`codex` scripts on `PATH`).

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
npx concilium doctor                # Check installed agent CLIs and their auth
npx concilium code "task" --agents claude,codex  # Candidates write code, one worktree and branch each
npx concilium code "fix the crash" --type bugfix # Pick the playbook instead of letting the classifier guess
npx concilium code "try a parser" --no-verify    # Skip the gates and integrity checks after the candidates
npx concilium code "rename a module" --no-adversarial  # Gates, but no adversarial tests
npx concilium code "add a flag" --no-judge       # Rank on the evidence only; ties stay tied
npx concilium gc --dry-run          # Show what gc would remove (worktrees, concilium/ branches)
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
import { DeliberationService, type HeadlessCliDriver } from '@concilium/core';
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
| `OPENROUTER_API_KEY` | core, cli, desktop | Optional OpenRouter API key, only for OpenRouter jurors or chairman. Beats the saved key. |
| `OPENROUTER_API_URL` | core, cli, desktop | Chat completions endpoint. Default `https://openrouter.ai/api/v1/chat/completions`. |
| `COUNCIL_MODELS` | core, cli, desktop | Comma-separated jurors (council member specs). Beats the saved jurors. |
| `CHAIRMAN_MODEL` | core, cli, desktop | Chairman (a council member spec). Beats the saved chairman. |
| `LOG_LEVEL` | core | `debug`, `info`, `warn` or `error` |
| `XDG_CONFIG_HOME` | cli | Override config directory |
| `XDG_DATA_HOME` | cli | Override data directory |
| `XDG_CACHE_HOME` | cli | Override cache directory |
| `SUPABASE_URL` | website | Supabase project URL (server-side only) |
| `SUPABASE_ANON_KEY` | website | Supabase anon key (server-side only) |

Config precedence, highest first, per setting: explicit overrides (`run --juror-models`/`--chairman`, the `deliberate()` options `councilModels`/`chairmanModel`/`apiKey`), then environment variable, then saved config (`concilium config set ...`, which merges into the saved settings), then built-in default (no API key; jurors and chairman left empty for the installed CLIs). `ConfigService.resolve(overrides)` implements it, `createConciliumRuntime` resolves it once per deliberation, fills in the council with `resolveCouncil` and passes it to `DeliberationService`, and `packages/core/src/services/config-service.test.ts` pins it.

## Pre-Submission Checklist
- [ ] Verified offline per `.claude/skills/verify-concilium/SKILL.md`: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint -w concilium` and `node packages/cli/dist/bin/concilium.js --help` all exit 0
- [ ] New behavior has a test, and a fixed bug has a test that failed before the fix
- [ ] If `npm run test:repo` asks you to lower `MISSING_HEADER_BASELINE`, lower it
- [ ] Changes in core don't break cli or desktop (the typecheck covers all three)

## License
All code must be compatible with the MIT License.
