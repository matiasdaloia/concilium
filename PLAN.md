# Concilium CLI — Full Implementation Plan

## Table of Contents

1. [Vision & Goals](#1-vision--goals)
2. [Domain-Driven Design: Strategic Design](#2-domain-driven-design-strategic-design)
3. [Monorepo Structure](#3-monorepo-structure)
4. [Phase 1: Extract `@concilium/core`](#4-phase-1-extract-conciliumcore)
5. [Phase 2: Build `@concilium/cli`](#5-phase-2-build-conciliumcli)
6. [Phase 3: Rewire `@concilium/desktop`](#6-phase-3-rewire-conciliumdesktop)
7. [Phase 4: Extensibility & Skill Integration](#7-phase-4-extensibility--skill-integration)
8. [Detailed File-by-File Plan](#8-detailed-file-by-file-plan)
9. [Migration Checklist](#9-migration-checklist)

---

## 1. Vision & Goals

### What we're building

A headless CLI for Concilium that runs the full 3-stage deliberation pipeline (Compete, Judge, Synthesize) entirely in the terminal, with rich Ink-based live UI, streaming output, and a programmatic API suitable for integration as a **skill** in coding agents (Claude Code, Codex, etc.).

### Design principles

- **DDD (Domain-Driven Design)**: Model the domain explicitly with bounded contexts, aggregates, value objects, domain events, and ports/adapters
- **Hexagonal Architecture**: Core domain has zero infrastructure dependencies; adapters plug in at the edges
- **Extensibility**: Every major extension point (agents, output formats, storage backends, pipeline stages) is a pluggable port
- **Skill-readiness**: The core exposes a clean programmatic API (`deliberate(config)`) that any agent SDK can call directly — no CLI parsing needed
- **Shared core**: Desktop and CLI are thin presentation layers over the same domain

### Key constraints

- No Electron dependencies in `core` or `cli` — `electron.safeStorage`, `electron.app`, `ipcMain` are all desktop-only
- No `process.exit()` in core — callers decide lifecycle
- All I/O behind ports (interfaces) — file system, network, encryption are injected

---

## 2. Domain-Driven Design: Strategic Design

### 2.1 Ubiquitous Language

| Term | Definition |
|------|-----------|
| **Deliberation** | A complete run of the 3-stage pipeline for a single prompt |
| **Agent** | An LLM-backed executor that produces an implementation plan (Claude, Codex, OpenCode, or custom) |
| **AgentProvider** | A pluggable adapter that knows how to run a specific type of agent |
| **Proposal** | An agent's response to the prompt (Stage 1 output) |
| **Juror** | A model that independently evaluates and ranks proposals |
| **Ranking** | A juror's ordered evaluation of proposals |
| **Chairman** | The model that synthesizes the best proposals into a final answer |
| **Synthesis** | The chairman's final combined output (Stage 3) |
| **Council** | The collective of jurors + chairman that evaluates proposals |
| **Run** | The persisted record of a completed deliberation |

### 2.2 Bounded Contexts

```
+--------------------------------------------------------------+
|                       CORE DOMAIN                            |
|                                                              |
|  +-------------------+  +-------------------+               |
|  |   Deliberation    |  |   Agent           |               |
|  |   Context         |  |   Context         |               |
|  |                   |  |                   |               |
|  |  - Deliberation   |  |  - AgentProvider  |               |
|  |  - Pipeline       |  |  - AgentExecutor  |               |
|  |  - Stage          |  |  - Proposal       |               |
|  |  - Ranking        |  |  - ParsedEvent    |               |
|  |  - Synthesis      |  |  - AgentConfig    |               |
|  +-------------------+  +-------------------+               |
|                                                              |
|  +-------------------+  +-------------------+               |
|  |   Council         |  |   Configuration   |               |
|  |   Context         |  |   Context         |               |
|  |                   |  |                   |               |
|  |  - Juror          |  |  - CouncilConfig  |               |
|  |  - Chairman       |  |  - AgentInstance  |               |
|  |  - AggregateRank  |  |  - Preferences    |               |
|  |  - PromptBuilder  |  |  - SecretStore    |               |
|  +-------------------+  +-------------------+               |
|                                                              |
|  +-------------------+                                       |
|  |   Persistence     |                                       |
|  |   Context         |                                       |
|  |                   |                                       |
|  |  - RunRepository  |                                       |
|  |  - RunRecord      |                                       |
|  |  - RunQuery       |                                       |
|  +-------------------+                                       |
+--------------------------------------------------------------+
```

### 2.3 Ports (Interfaces the domain defines)

```typescript
// --- Agent Execution Port ---
interface AgentProvider {
  readonly id: string;
  readonly name: string;
  discoverModels(): Promise<string[]>;
  execute(config: AgentExecutionConfig): Promise<AgentResult>;
}

// --- LLM Gateway Port (for council queries via OpenRouter) ---
interface LlmGateway {
  query(model: string, messages: Message[], opts?: QueryOptions): Promise<LlmResponse | null>;
  queryStreaming(model: string, messages: Message[], onChunk: ChunkCb, opts?: QueryOptions): Promise<LlmResponse | null>;
  listModels(): Promise<ModelInfo[]>;
}

// --- Persistence Port ---
interface RunRepository {
  save(run: RunRecord): Promise<void>;
  load(id: string): Promise<RunRecord>;
  list(): Promise<RunSummary[]>;
  loadAll(): Promise<RunRecord[]>;
}

// --- Configuration Port ---
interface ConfigStore {
  getCouncilConfig(): Promise<CouncilConfig>;
  saveCouncilConfig(config: Partial<CouncilConfig>): Promise<void>;
  getAgentInstances(): Promise<AgentInstance[]>;
  saveAgentInstances(instances: AgentInstance[]): Promise<void>;
}

// --- Secret Storage Port ---
interface SecretStore {
  encrypt(value: string): string;
  decrypt(encrypted: string): string;
}

// --- Event Emitter Port (domain events for streaming) ---
interface DeliberationEvents {
  onStageChange(stage: number, summary: string): void;
  onAgentStatus(agentKey: string, status: AgentStatus, name?: string): void;
  onAgentEvent(agentKey: string, event: ParsedEvent): void;
  onJurorStatus(model: string, status: JurorStatus): void;
  onJurorChunk(model: string, chunk: string): void;
  onJurorComplete(model: string, success: boolean, usage?: TokenUsage): void;
  onSynthesisStart(): void;
  onComplete(record: RunRecord): void;
  onError(error: string): void;
}
```

### 2.4 Adapters (Infrastructure implementations)

| Port | Desktop Adapter | CLI Adapter |
|------|----------------|-------------|
| `SecretStore` | `ElectronSafeStorageAdapter` (uses `safeStorage`) | `PlaintextSecretAdapter` (base64 fallback) |
| `RunRepository` | `JsonFileRunRepository` (uses `app.getPath`) | `JsonFileRunRepository` (uses `~/.config/concilium`) |
| `ConfigStore` | `ElectronConfigStore` (uses `app.getPath`) | `XdgConfigStore` (uses `~/.config/concilium`) |
| `LlmGateway` | `OpenRouterGateway` (shared) | `OpenRouterGateway` (shared) |
| `AgentProvider` | `ClaudeCliProvider`, `CodexSdkProvider`, `OpenCodeSdkProvider` | Same (shared) |
| `DeliberationEvents` | `IpcEventBridge` (sends via `webContents.send`) | `CallbackEventBridge` (calls functions that update Ink state) |

---

## 3. Monorepo Structure

```
concilium/
|-- package.json                    # Root workspace config
|-- tsconfig.base.json              # Shared TS compiler options
|
|-- packages/
|   |-- core/                       # @concilium/core
|   |   |-- package.json
|   |   |-- tsconfig.json
|   |   +-- src/
|   |       |-- index.ts            # Public API barrel
|   |       |
|   |       |-- domain/             # Pure domain model
|   |       |   |-- deliberation/
|   |       |   |   |-- deliberation.ts        # StartRunConfig, ImageAttachment
|   |       |   |   |-- pipeline.ts            # PipelineOrchestrator (stages 2+3)
|   |       |   |   |-- ranking.ts             # parseRankingFromText, calculateAggregateRankings
|   |       |   |   +-- prompts.ts             # wrapPromptForResearch, buildRankingPrompt, buildSynthesisPrompt
|   |       |   |
|   |       |   |-- agent/
|   |       |   |   |-- agent-config.ts        # AgentId, AgentProvider, AgentInstance, AgentConfig, AgentStatus
|   |       |   |   |-- agent-result.ts        # AgentResult entity
|   |       |   |   |-- parsed-event.ts        # ParsedEvent, EventType, TokenUsage
|   |       |   |   +-- agent-executor.ts      # runAgentsParallel, RunController
|   |       |   |
|   |       |   |-- council/
|   |       |   |   |-- council-config.ts      # CouncilConfig VO (without openRouterApiKey — that's infra)
|   |       |   |   |-- stage-results.ts       # Stage1Result, Stage2Result, Stage3Result
|   |       |   |   +-- model-info.ts          # OpenRouterModelInfo, pricing helpers
|   |       |   |
|   |       |   +-- run/
|   |       |       |-- run-record.ts          # RunRecord aggregate
|   |       |       +-- run-metadata.ts        # RunMetadata, AggregateRanking, UserRanking, ModelPerformanceSnapshot
|   |       |
|   |       |-- ports/              # Port interfaces (contracts)
|   |       |   |-- agent-provider.ts
|   |       |   |-- llm-gateway.ts
|   |       |   |-- run-repository.ts
|   |       |   |-- config-store.ts
|   |       |   |-- secret-store.ts
|   |       |   +-- deliberation-events.ts
|   |       |
|   |       |-- adapters/           # Shared adapters (framework-agnostic, no Electron)
|   |       |   |-- openrouter-gateway.ts      # LlmGateway implementation
|   |       |   |-- claude-provider.ts         # AgentProvider for Claude CLI
|   |       |   |-- codex-provider.ts          # AgentProvider for Codex SDK
|   |       |   |-- opencode-provider.ts       # AgentProvider for OpenCode SDK
|   |       |   |-- json-run-repository.ts     # RunRepository (accepts dataDir param)
|   |       |   |-- json-config-store.ts       # ConfigStore (accepts configDir param)
|   |       |   |-- plaintext-secret-store.ts  # SecretStore (base64, no OS keychain)
|   |       |   +-- parsers/
|   |       |       |-- claude-parser.ts       # parseClaudeEventLine
|   |       |       +-- index.ts
|   |       |
|   |       |-- services/           # Application services (use cases)
|   |       |   |-- deliberation-service.ts    # Main: runDeliberation()
|   |       |   |-- config-service.ts          # Config resolution (env > prefs > defaults)
|   |       |   +-- model-discovery-service.ts # Discovers models across all providers
|   |       |
|   |       +-- shared/             # Cross-cutting
|   |           |-- logger.ts
|   |           |-- types.ts                   # ID type aliases
|   |           +-- errors.ts                  # ConciliumError, ConfigError, etc.
|   |
|   |-- cli/                        # @concilium/cli
|   |   |-- package.json
|   |   |-- tsconfig.json
|   |   |-- bin/
|   |   |   +-- concilium.ts        # Entry point (#!/usr/bin/env node)
|   |   +-- src/
|   |       |-- index.ts            # Programmatic API: deliberate()
|   |       |
|   |       |-- commands/           # Commander command definitions
|   |       |   |-- run.ts          # concilium run <prompt>
|   |       |   |-- history.ts      # concilium history [run-id]
|   |       |   |-- config.ts       # concilium config [set|get|reset]
|   |       |   |-- models.ts       # concilium models
|   |       |   +-- gui.ts          # concilium gui (launch Electron)
|   |       |
|   |       |-- ui/                 # Ink React components
|   |       |   |-- App.tsx                    # Root Ink app
|   |       |   |-- RunView.tsx                # Live deliberation orchestrator
|   |       |   |-- components/
|   |       |   |   |-- AgentProgress.tsx
|   |       |   |   |-- JurorProgress.tsx
|   |       |   |   |-- StageIndicator.tsx
|   |       |   |   |-- Leaderboard.tsx
|   |       |   |   |-- SynthesisView.tsx
|   |       |   |   |-- CostSummary.tsx
|   |       |   |   |-- Spinner.tsx
|   |       |   |   +-- MarkdownRenderer.tsx
|   |       |   +-- hooks/
|   |       |       +-- useDeliberation.ts     # Domain events -> Ink state
|   |       |
|   |       |-- adapters/           # CLI-specific adapters
|   |       |   |-- callback-event-bridge.ts   # DeliberationEvents -> callbacks
|   |       |   |-- xdg-paths.ts               # XDG-compliant config/data dirs
|   |       |   +-- terminal-secret-store.ts   # env var or dotfile secrets
|   |       |
|   |       +-- formatters/         # Output formatters (extensible)
|   |           |-- formatter.ts               # OutputFormatter interface
|   |           |-- interactive.ts             # Ink live UI (default for TTY)
|   |           |-- json.ts                    # --json
|   |           |-- markdown.ts                # --format md
|   |           +-- plain.ts                   # piped/non-TTY output
|   |
|   +-- desktop/                    # @concilium/desktop (existing, refactored)
|       |-- package.json            # Adds @concilium/core dependency
|       |-- tsconfig.json
|       +-- src/
|           |-- main/
|           |   |-- main.ts                    # Electron lifecycle (thinner)
|           |   |-- ipc.ts                     # Thin layer delegating to core services
|           |   +-- adapters/
|           |       |-- electron-secret-store.ts    # safeStorage wrapper
|           |       |-- electron-config-store.ts    # app.getPath-based ConfigStore
|           |       |-- electron-event-bridge.ts    # webContents.send-based events
|           |       +-- electron-run-repository.ts  # userData-based storage
|           |-- preload/                            # Unchanged
|           +-- renderer/                           # Unchanged
|
|-- website/                         # Unchanged
+-- assets/                          # Unchanged
```

---

## 4. Phase 1: Extract `@concilium/core`

This is the critical phase. We extract domain logic from `desktop/src/main/services/` into a framework-agnostic package.

### Step 1.1: Set up monorepo workspace

**Create/modify:**
- Root `package.json` — add `"workspaces": ["packages/*", "website"]`
- `tsconfig.base.json` — shared compiler options (strict, ESNext, bundler resolution)
- `packages/core/package.json` — name `@concilium/core`, type `module`, exports map
- `packages/core/tsconfig.json` — extends base, `composite: true` for project references

### Step 1.2: Define domain types

**Source**: `desktop/src/main/services/types.ts` (153 lines)

Decompose into domain model files:

| Current type | Target file | Category |
|-------------|-------------|----------|
| `AgentId`, `AgentProvider`, `AgentInstance`, `AgentConfig`, `AgentStatus` | `domain/agent/agent-config.ts` | Value objects |
| `ParsedEvent`, `EventType`, `TokenUsage` | `domain/agent/parsed-event.ts` | Value objects |
| `AgentResult` | `domain/agent/agent-result.ts` | Entity |
| `Stage1Result`, `Stage2Result`, `Stage3Result`, `CouncilTokenUsage` | `domain/council/stage-results.ts` | Value objects |
| `CouncilConfig`, `CommandSpec` | `domain/council/council-config.ts` | Value objects |
| `RunRecord` | `domain/run/run-record.ts` | Aggregate root |
| `RunMetadata`, `AggregateRanking`, `UserRanking`, `ModelPerformanceSnapshot` | `domain/run/run-metadata.ts` | Value objects |
| `ImageAttachment`, `StartRunConfig` | `domain/deliberation/deliberation.ts` | Value objects |

### Step 1.3: Define port interfaces

Create the 6 port interfaces listed in section 2.3. Pure TypeScript interfaces with zero imports from infrastructure.

**Key design decision**: `CouncilConfig` in the domain layer contains model names and URLs but NOT the API key. The API key is resolved by the `ConfigService` which combines the `SecretStore` port with the config. This keeps secrets out of the domain model.

### Step 1.4: Extract domain logic

| Source file | Target file(s) | Changes needed |
|-------------|----------------|----------------|
| `pipeline.ts` (327 lines) | `domain/deliberation/pipeline.ts` + `ranking.ts` + `prompts.ts` | Replace direct `openrouter.ts` calls with `LlmGateway` port. Split `runCouncilStages()` into a `PipelineOrchestrator` class that receives ports via constructor injection. Extract `parseRankingFromText()` + `calculateAggregateRankings()` into `ranking.ts`. Extract `buildRankingPrompt()` + `buildSynthesisPrompt()` into `prompts.ts`. Extract `wrapPromptForResearch()` from `commands.ts` into `prompts.ts`. |
| `runner.ts` (515 lines) | `domain/agent/agent-executor.ts` | Replace hardcoded agent switch (`if agent.id === 'opencode'`) with `AgentProvider` port registry. `AgentExecutor.runAll(agents, providers)` looks up provider by id. `RunController` moves here unchanged (it's pure process management logic). Model discovery functions move to `ModelDiscoveryService`. |
| `openrouter.ts` (537 lines) | `adapters/openrouter-gateway.ts` | Implement `LlmGateway` port. No Electron deps to remove. Move caching, fallback models, pricing utils. Class with constructor accepting `apiKey` and `apiUrl`. |
| `commands.ts` (60 lines) | Split: `prompts.ts` gets `wrapPromptForResearch()`, `claude-provider.ts` gets `buildClaudeCommand()` | Prompt wrapping is domain logic. Command building is Claude-specific infrastructure. |
| `parsers.ts` (189 lines) | `adapters/parsers/claude-parser.ts` | Move as-is. Already framework-agnostic. |
| `codex-client.ts` (272 lines) | `adapters/codex-provider.ts` | Wrap as `AgentProvider` implementation. The `runCodexSdk()` function becomes the `execute()` method. |
| `opencode-client.ts` (566 lines) | `adapters/opencode-provider.ts` | Wrap as `AgentProvider` implementation. Server lifecycle management stays here. |
| `storage.ts` (399 lines) | `json-run-repository.ts` + `json-config-store.ts` + `plaintext-secret-store.ts` | **Critical**: Remove `electron` imports (`app`, `safeStorage`). Constructor accepts `dataDir: string` instead of calling `app.getPath()`. Encryption becomes a `SecretStore` port injected via constructor. `getCouncilConfig()` moves to `ConfigService`. |
| `logger.ts` (68 lines) | `shared/logger.ts` | Move as-is. Already framework-agnostic. |

### Step 1.5: Create application services

**`deliberation-service.ts`** — the main public API (extracted from `ipc.ts` lines 141-393):

```typescript
export interface DeliberationInput {
  prompt: string;
  images?: ImageAttachment[];
  agentInstances: AgentInstance[];
  cwd: string;
}

export interface DeliberationDeps {
  providers: Map<string, AgentProvider>;
  llmGateway: LlmGateway;
  configStore: ConfigStore;
  runRepository: RunRepository;
  events: DeliberationEvents;
}

export class DeliberationService {
  private activeControllers = new Map<string, RunController>();

  constructor(private deps: DeliberationDeps) {}

  async run(input: DeliberationInput): Promise<RunRecord> {
    // 1. Load council config via configStore
    // 2. Build agent configs from instances
    // 3. Emit stage:change(1)
    // 4. Stage 1: runAgentsParallel using registered providers
    // 5. Build Stage1Results from successful agents
    // 6. Emit stage:change(2)
    // 7. Stage 2+3: PipelineOrchestrator.execute(llmGateway, ...)
    // 8. Build RunRecord
    // 9. runRepository.save(record)
    // 10. Emit complete(record)
    // 11. Return record
  }

  cancel(runId: string): void { ... }
  cancelAgent(runId: string, agentKey: string): boolean { ... }
  cancelAll(): void { ... }
}
```

**`config-service.ts`** — extracted from `storage.ts` `getCouncilConfig()`:

```typescript
export class ConfigService {
  constructor(
    private configStore: ConfigStore,
    private secretStore: SecretStore,
  ) {}

  async resolve(): Promise<ResolvedCouncilConfig> {
    // Priority: env vars > stored prefs > defaults
  }

  async saveApiKey(key: string): Promise<void> {
    // Encrypt via secretStore, persist via configStore
  }
}
```

**`model-discovery-service.ts`** — extracted from `runner.ts`:

```typescript
export class ModelDiscoveryService {
  constructor(private providers: Map<string, AgentProvider>) {}

  async discoverAll(): Promise<AgentModelInfo[]> {
    // Iterate providers, call discoverModels() on each
  }
}
```

### Step 1.6: Barrel export (`packages/core/src/index.ts`)

Re-exports all domain types, ports, adapters, and services. This is the single import point for consumers:

```typescript
// Example consumer usage:
import {
  DeliberationService,
  OpenRouterGateway,
  ClaudeProvider,
  JsonRunRepository,
  type RunRecord,
} from '@concilium/core';
```

---

## 5. Phase 2: Build `@concilium/cli`

### Step 2.1: Package setup

**`packages/cli/package.json`** key dependencies:
- `@concilium/core` (workspace)
- `commander` ^13.x — argument parsing
- `ink` ^5.x + `react` ^19.x — terminal UI
- `ink-spinner` ^5.x — animated spinners
- `marked` + `marked-terminal` — markdown rendering in terminal
- `chalk` ^5.x — colors
- `cli-table3` — table formatting

Build tool: `tsup` (esbuild-based, fast, handles JSX).

### Step 2.2: CLI entry point

**`packages/cli/bin/concilium.ts`**:

```
concilium run <prompt>           # Run deliberation
concilium run -f <file>          # Prompt from file
concilium run -f -               # Prompt from stdin
concilium history [run-id]       # List or view runs
concilium config [set|get|reset] # Manage configuration
concilium models                 # List available models
concilium gui [path]             # Launch Electron GUI
```

Commander setup with subcommands. If no subcommand and a bare string argument, treat as `run`.

### Step 2.3: The `run` command flags

```
Options:
  -f, --file <path>              Read prompt from file (- for stdin)
  --agents <list>                Agents to use (e.g. "claude,codex" or "claude:opus,codex:gpt-5.2-codex")
  --juror-models <list>          Juror models (comma-separated OpenRouter model IDs)
  --jurors <n>                   Number of juror models (uses defaults)
  --chairman <model>             Chairman model (OpenRouter model ID)
  --stage1-only                  Skip council stages (just run agents)
  --cwd <path>                   Project working directory (default: current dir)
  --json                         Output as JSON to stdout
  --format <type>                Output format: interactive (default), md, plain
  --output <file>                Save synthesis to file
  --no-save                      Don't persist run to history
  --verbose                      Debug logging
  --quiet                        Minimal output (suppress progress, just print result)
```

### Step 2.4: Ink UI components

**Terminal UX during a run:**

```
  Stage 1: Competing

  claude (opus)       ==================== done (42s)
  codex (gpt-5.2)     ============-------- streaming...
  opencode (gemini)   ==================== done (38s)

  Stage 2: Judging (3 jurors)

  openai/gpt-4o               ==================== done
  anthropic/claude-sonnet-4-5 ============-------- streaming...
  google/gemini-3-pro         ==================== done

  Rankings:  1st claude (1.33)  2nd opencode (2.00)  3rd codex (2.67)

  Stage 3: Synthesizing
  * Chairman producing final answer...

  ======================================================
  SYNTHESIS
  ======================================================

  [rendered markdown output]

  ------------------------------------------------------
  Cost: $0.12 | Tokens: 45,230 | Duration: 2m 18s
  Run saved: run_abc123
```

**Components:**

| Component | Purpose | Props |
|-----------|---------|-------|
| `<RunView>` | Root orchestrator, manages layout | `config: DeliberationInput` |
| `<StageIndicator>` | Shows current/completed/pending stages | `stage: number, summary: string` |
| `<AgentProgress>` | Single agent line: name, bar, status, time | `name, status, elapsed` |
| `<JurorProgress>` | Single juror line with streaming indicator | `model, status, textLength` |
| `<Leaderboard>` | Rankings table after Stage 2 | `rankings: AggregateRanking[]` |
| `<SynthesisView>` | Rendered markdown of final output | `text: string` |
| `<CostSummary>` | Token count, cost, duration, run ID | `record: RunRecord` |
| `<Spinner>` | Braille/dots animation | `text: string` |
| `<MarkdownRenderer>` | Terminal markdown via marked-terminal | `content: string` |

### Step 2.5: `useDeliberation` hook

Connects domain events to Ink component state via `useReducer`:

```typescript
function useDeliberation(config: DeliberationInput): DeliberationState {
  const [state, dispatch] = useReducer(deliberationReducer, initialState);

  useEffect(() => {
    // Create a CallbackEventBridge that dispatches to reducer
    const events: DeliberationEvents = {
      onStageChange: (stage, summary) =>
        dispatch({ type: 'STAGE_CHANGE', stage, summary }),
      onAgentStatus: (key, status, name) =>
        dispatch({ type: 'AGENT_STATUS', key, status, name }),
      onAgentEvent: (key, event) =>
        dispatch({ type: 'AGENT_EVENT', key, event }),
      // ... etc for all event types
    };

    // Wire up core service with CLI adapters
    const service = buildService(events);
    service.run(config).catch(err =>
      dispatch({ type: 'ERROR', error: err.message })
    );

    return () => service.cancel();
  }, []);

  return state;
}
```

### Step 2.6: Output formatters

Port interface:
```typescript
interface OutputFormatter {
  renderProgress(state: DeliberationState): void;  // live updates
  renderComplete(record: RunRecord): void;          // final output
  renderError(error: string): void;
}
```

Implementations:
- **InteractiveFormatter**: Renders Ink `<RunView>` (default when stdout is a TTY)
- **JsonFormatter**: Outputs `RunRecord` as JSON on completion (for `--json`)
- **MarkdownFormatter**: Renders synthesis as terminal markdown (for `--format md`)
- **PlainFormatter**: No ANSI codes, simple text (auto-selected when piped)

Auto-detection: `process.stdout.isTTY` -> interactive, otherwise plain.

### Step 2.7: CLI-specific adapters

**`xdg-paths.ts`**: Storage directories following XDG Base Directory spec:
- Config: `$XDG_CONFIG_HOME/concilium` or `~/.config/concilium`
- Data (runs): `$XDG_DATA_HOME/concilium` or `~/.local/share/concilium`
- Cache: `$XDG_CACHE_HOME/concilium` or `~/.cache/concilium`

**`terminal-secret-store.ts`**: API key storage without Electron:
- Primary: Environment variable `OPENROUTER_API_KEY`
- Secondary: Plaintext in config file with `chmod 600`
- File: `~/.config/concilium/config.json`

**`callback-event-bridge.ts`**: Implements `DeliberationEvents` by calling injected callback functions. The `useDeliberation` hook creates this bridge, passing dispatch functions as callbacks.

### Step 2.8: Other commands

**`concilium history`**:
```
concilium history                    # Table of all runs
concilium history <run-id>           # Show specific run
concilium history <run-id> --json    # Machine-readable
concilium history --last             # Most recent run
concilium history --last --synthesis # Just print synthesis text
```

**`concilium config`**:
```
concilium config                     # Show current (redacted API key)
concilium config set api-key         # Prompt securely for API key
concilium config set chairman <model>
concilium config set jurors <m1,m2>
concilium config reset               # Reset to defaults
concilium config path                # Print config file location
```

**`concilium models`**:
```
concilium models                     # All models (table)
concilium models --agent claude      # Models for specific agent
concilium models --council           # OpenRouter models for jurors/chairman
concilium models --refresh           # Force refresh from APIs
```

**`concilium gui`**:
```
concilium gui                        # Launch Electron GUI
concilium gui <path>                 # For specific project
```

This replaces the existing `desktop/bin/concilium.js`. The old behavior of `concilium` launching the GUI becomes `concilium gui`. Running bare `concilium` now shows help (or could default to `run` if args are provided).

---

## 6. Phase 3: Rewire `@concilium/desktop`

### Step 3.1: Add core dependency

Add `"@concilium/core": "workspace:*"` to `packages/desktop/package.json`.

### Step 3.2: Create desktop-specific adapters

**`adapters/electron-secret-store.ts`**:
```typescript
import { safeStorage } from 'electron';
import type { SecretStore } from '@concilium/core';

export class ElectronSecretStore implements SecretStore {
  encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(value).toString('base64');
    }
    return safeStorage.encryptString(value).toString('base64');
  }

  decrypt(encrypted: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(encrypted, 'base64').toString('utf-8');
    }
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }
}
```

**`adapters/electron-event-bridge.ts`**:
```typescript
import type { BrowserWindow } from 'electron';
import type { DeliberationEvents } from '@concilium/core';

export class ElectronEventBridge implements DeliberationEvents {
  constructor(private window: BrowserWindow) {}

  private send(channel: string, ...args: unknown[]) {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, ...args);
    }
  }

  onStageChange(stage: number, summary: string) { this.send('stage:change', stage, summary); }
  onAgentStatus(key: string, status: string, name?: string) { this.send('agent:status', key, status, name); }
  onAgentEvent(key: string, event: unknown) { this.send('agent:event', key, event); }
  // ... etc
}
```

### Step 3.3: Rewrite `ipc.ts`

The 543-line `ipc.ts` becomes a thin delegation layer (~100 lines):

```typescript
import { DeliberationService, ConfigService, ModelDiscoveryService, ... } from '@concilium/core';
import { ElectronSecretStore } from './adapters/electron-secret-store';
import { ElectronEventBridge } from './adapters/electron-event-bridge';

export function registerIpcHandlers(mainWindow: BrowserWindow, projectCwd: string) {
  const secretStore = new ElectronSecretStore();
  const events = new ElectronEventBridge(mainWindow);
  // Build all dependencies via factory
  const deps = createDefaultDependencies({
    events, secretStore, dataDir: app.getPath('userData')
  });
  const deliberation = new DeliberationService(deps);
  const config = new ConfigService(deps.configStore, secretStore);
  const models = new ModelDiscoveryService(deps.providers);

  ipcMain.handle('run:start', (_, params) => deliberation.run({ ...params, cwd: projectCwd }));
  ipcMain.handle('run:cancel', (_, runId) => deliberation.cancel(runId));
  ipcMain.handle('config:get', () => config.resolve());
  ipcMain.handle('models:discover', () => models.discoverAll());
  // ... simple delegation for all other handlers
}
```

### Step 3.4: Delete `desktop/src/main/services/`

After confirming the desktop app builds and runs correctly with core imports, delete the entire `services/` directory. All domain logic now lives in `@concilium/core`.

### Step 3.5: What stays in desktop

- `main.ts` — Electron lifecycle, window creation, `.env` loading
- `ipc.ts` — Thin IPC delegation layer
- `adapters/` — 4 Electron-specific adapter files
- `preload/` — Unchanged
- `renderer/` — Unchanged (all React components, hooks, screens)

---

## 7. Phase 4: Extensibility & Skill Integration

### 7.1: Programmatic API

**`packages/cli/src/index.ts`** — importable by any Node.js consumer:

```typescript
import {
  DeliberationService,
  OpenRouterGateway,
  ClaudeProvider,
  CodexProvider,
  JsonRunRepository,
  JsonConfigStore,
  PlaintextSecretStore,
  type RunRecord,
  type DeliberationEvents,
} from '@concilium/core';

export interface ConciliumOptions {
  prompt: string;
  cwd?: string;
  agents?: Array<{ provider: string; model?: string }>;
  councilModels?: string[];
  chairmanModel?: string;
  apiKey?: string;
  onProgress?: (event: ProgressEvent) => void;
  stage1Only?: boolean;
  save?: boolean;
}

// High-level convenience function
export async function deliberate(options: ConciliumOptions): Promise<RunRecord> {
  // 1. Build providers from options.agents
  // 2. Create LlmGateway with apiKey
  // 3. Create storage (XDG paths or no-save)
  // 4. Wire up events to options.onProgress
  // 5. Run DeliberationService
  // 6. Return RunRecord
}

// Re-export everything from core for advanced usage
export * from '@concilium/core';
```

**Usage as a Claude Code skill:**
```typescript
import { deliberate } from '@concilium/cli';

const result = await deliberate({
  prompt: 'Refactor the auth module to use JWT',
  cwd: process.cwd(),
  agents: [{ provider: 'claude', model: 'opus' }, { provider: 'codex' }],
  apiKey: process.env.OPENROUTER_API_KEY,
});

console.log(result.stage3?.response); // The synthesis
```

**Usage as shell command (stdin/stdout contract):**
```bash
echo "Refactor auth to JWT" | concilium run -f - --json --quiet
```

### 7.2: Agent provider plugin system

Custom agents implement the `AgentProvider` port:

```typescript
import { type AgentProvider } from '@concilium/core';

class GeminiDirectProvider implements AgentProvider {
  readonly id = 'gemini-direct';
  readonly name = 'Gemini Direct';

  async discoverModels() { return ['gemini-3-pro', 'gemini-3-flash']; }

  async execute(config) {
    // Custom execution logic (e.g., Google AI SDK)
    return { id: 'gemini-direct', name: this.name, status: 'success', ... };
  }
}

// Register with the service
const providers = new Map();
providers.set('gemini-direct', new GeminiDirectProvider());
```

The CLI would support loading plugins via config:
```json
// ~/.config/concilium/config.json
{
  "plugins": ["concilium-plugin-gemini", "./my-custom-agent.js"]
}
```

### 7.3: Custom output formatters

```typescript
import { type OutputFormatter } from '@concilium/cli';

class WebhookFormatter implements OutputFormatter {
  renderComplete(record) {
    fetch('https://slack.webhook.url', {
      method: 'POST',
      body: JSON.stringify({ text: record.stage3?.response }),
    });
  }
}
```

### 7.4: Pipeline hooks (middleware)

For intercepting/transforming at each stage boundary:

```typescript
interface PipelineHooks {
  beforeStage1?(config: DeliberationInput): DeliberationInput | void;
  afterStage1?(results: AgentResult[]): AgentResult[] | void;
  beforeStage2?(proposals: Stage1Result[]): Stage1Result[] | void;
  afterStage2?(rankings: Stage2Result[]): Stage2Result[] | void;
  beforeStage3?(context: SynthesisContext): SynthesisContext | void;
  afterStage3?(synthesis: Stage3Result): Stage3Result | void;
}
```

Hooks can transform data (return new value) or just observe (return void). Registered via the `DeliberationService` constructor.

---

## 8. Detailed File-by-File Plan

### Files to CREATE (new)

| # | File | Purpose | ~Lines |
|---|------|---------|--------|
| 1 | `package.json` (root) | Workspace config | 15 |
| 2 | `tsconfig.base.json` | Shared TS config | 25 |
| 3 | `packages/core/package.json` | Core manifest | 25 |
| 4 | `packages/core/tsconfig.json` | Core TS config | 15 |
| 5 | `packages/core/src/index.ts` | Barrel export | 40 |
| 6 | `packages/core/src/shared/types.ts` | Shared type aliases | 20 |
| 7 | `packages/core/src/shared/errors.ts` | Domain errors | 30 |
| 8 | `packages/core/src/shared/logger.ts` | Logger (from services/) | 68 |
| 9 | `packages/core/src/domain/agent/agent-config.ts` | Agent types | 35 |
| 10 | `packages/core/src/domain/agent/agent-result.ts` | AgentResult | 30 |
| 11 | `packages/core/src/domain/agent/parsed-event.ts` | ParsedEvent types | 25 |
| 12 | `packages/core/src/domain/agent/agent-executor.ts` | Parallel runner + RunController | 120 |
| 13 | `packages/core/src/domain/council/council-config.ts` | Council types | 30 |
| 14 | `packages/core/src/domain/council/stage-results.ts` | Stage result types | 45 |
| 15 | `packages/core/src/domain/council/model-info.ts` | Model metadata, pricing helpers | 25 |
| 16 | `packages/core/src/domain/deliberation/deliberation.ts` | StartRunConfig, ImageAttachment | 30 |
| 17 | `packages/core/src/domain/deliberation/pipeline.ts` | PipelineOrchestrator | 180 |
| 18 | `packages/core/src/domain/deliberation/ranking.ts` | parseRankingFromText, aggregate | 75 |
| 19 | `packages/core/src/domain/deliberation/prompts.ts` | Prompt builders (research, ranking, synthesis) | 120 |
| 20 | `packages/core/src/domain/run/run-record.ts` | RunRecord aggregate | 30 |
| 21 | `packages/core/src/domain/run/run-metadata.ts` | RunMetadata, AggregateRanking, etc. | 35 |
| 22 | `packages/core/src/ports/agent-provider.ts` | AgentProvider interface | 25 |
| 23 | `packages/core/src/ports/llm-gateway.ts` | LlmGateway interface | 30 |
| 24 | `packages/core/src/ports/run-repository.ts` | RunRepository interface | 20 |
| 25 | `packages/core/src/ports/config-store.ts` | ConfigStore interface | 25 |
| 26 | `packages/core/src/ports/secret-store.ts` | SecretStore interface | 10 |
| 27 | `packages/core/src/ports/deliberation-events.ts` | DeliberationEvents interface | 20 |
| 28 | `packages/core/src/adapters/openrouter-gateway.ts` | LlmGateway impl | 450 |
| 29 | `packages/core/src/adapters/claude-provider.ts` | AgentProvider for Claude CLI | 180 |
| 30 | `packages/core/src/adapters/codex-provider.ts` | AgentProvider for Codex SDK | 250 |
| 31 | `packages/core/src/adapters/opencode-provider.ts` | AgentProvider for OpenCode SDK | 500 |
| 32 | `packages/core/src/adapters/json-run-repository.ts` | JSON file RunRepository | 150 |
| 33 | `packages/core/src/adapters/json-config-store.ts` | JSON file ConfigStore | 160 |
| 34 | `packages/core/src/adapters/plaintext-secret-store.ts` | Base64 SecretStore | 20 |
| 35 | `packages/core/src/adapters/parsers/claude-parser.ts` | parseClaudeEventLine | 189 |
| 36 | `packages/core/src/adapters/parsers/index.ts` | Parser barrel | 5 |
| 37 | `packages/core/src/services/deliberation-service.ts` | Main use case | 200 |
| 38 | `packages/core/src/services/config-service.ts` | Config resolution | 80 |
| 39 | `packages/core/src/services/model-discovery-service.ts` | Model discovery | 60 |
| 40 | `packages/cli/package.json` | CLI manifest | 30 |
| 41 | `packages/cli/tsconfig.json` | CLI TS config | 15 |
| 42 | `packages/cli/bin/concilium.ts` | Entry point | 50 |
| 43 | `packages/cli/src/index.ts` | Programmatic API: deliberate() | 80 |
| 44 | `packages/cli/src/commands/run.ts` | Run command | 150 |
| 45 | `packages/cli/src/commands/history.ts` | History command | 100 |
| 46 | `packages/cli/src/commands/config.ts` | Config command | 120 |
| 47 | `packages/cli/src/commands/models.ts` | Models command | 80 |
| 48 | `packages/cli/src/commands/gui.ts` | GUI launcher (backward compat) | 50 |
| 49 | `packages/cli/src/ui/App.tsx` | Root Ink component | 40 |
| 50 | `packages/cli/src/ui/RunView.tsx` | Live run orchestrator | 120 |
| 51 | `packages/cli/src/ui/components/AgentProgress.tsx` | Agent progress bar | 60 |
| 52 | `packages/cli/src/ui/components/JurorProgress.tsx` | Juror progress | 50 |
| 53 | `packages/cli/src/ui/components/StageIndicator.tsx` | Stage 1/2/3 indicator | 40 |
| 54 | `packages/cli/src/ui/components/Leaderboard.tsx` | Rankings table | 50 |
| 55 | `packages/cli/src/ui/components/SynthesisView.tsx` | Final output view | 40 |
| 56 | `packages/cli/src/ui/components/CostSummary.tsx` | Cost + tokens + duration | 40 |
| 57 | `packages/cli/src/ui/components/Spinner.tsx` | Animated spinner | 20 |
| 58 | `packages/cli/src/ui/components/MarkdownRenderer.tsx` | Terminal markdown | 30 |
| 59 | `packages/cli/src/ui/hooks/useDeliberation.ts` | Domain events -> React state | 100 |
| 60 | `packages/cli/src/adapters/callback-event-bridge.ts` | DeliberationEvents -> callbacks | 50 |
| 61 | `packages/cli/src/adapters/xdg-paths.ts` | XDG path resolution | 30 |
| 62 | `packages/cli/src/adapters/terminal-secret-store.ts` | Env/dotfile secrets | 40 |
| 63 | `packages/cli/src/formatters/formatter.ts` | OutputFormatter port | 15 |
| 64 | `packages/cli/src/formatters/interactive.ts` | Ink formatter | 60 |
| 65 | `packages/cli/src/formatters/json.ts` | JSON formatter | 30 |
| 66 | `packages/cli/src/formatters/markdown.ts` | Markdown formatter | 40 |
| 67 | `packages/cli/src/formatters/plain.ts` | Plain text formatter | 40 |
| 68 | `packages/desktop/src/main/adapters/electron-secret-store.ts` | safeStorage wrapper | 25 |
| 69 | `packages/desktop/src/main/adapters/electron-event-bridge.ts` | IPC event bridge | 40 |
| 70 | `packages/desktop/src/main/adapters/electron-config-store.ts` | app.getPath config | 30 |
| 71 | `packages/desktop/src/main/adapters/electron-run-repository.ts` | userData storage | 20 |

### Files to MOVE/REFACTOR

| Source | Destination | Action |
|--------|-------------|--------|
| `desktop/src/main/services/types.ts` | Decomposed into `core/src/domain/**` | Split into 8 domain files |
| `desktop/src/main/services/pipeline.ts` | `core/src/domain/deliberation/{pipeline,ranking,prompts}.ts` | Refactor with port injection |
| `desktop/src/main/services/runner.ts` | `core/src/domain/agent/agent-executor.ts` | Refactor to use AgentProvider port |
| `desktop/src/main/services/openrouter.ts` | `core/src/adapters/openrouter-gateway.ts` | Wrap as LlmGateway class |
| `desktop/src/main/services/commands.ts` | Split: prompts -> core domain, claude cmd -> core adapter | Split |
| `desktop/src/main/services/parsers.ts` | `core/src/adapters/parsers/claude-parser.ts` | Move (already portable) |
| `desktop/src/main/services/codex-client.ts` | `core/src/adapters/codex-provider.ts` | Wrap as AgentProvider |
| `desktop/src/main/services/opencode-client.ts` | `core/src/adapters/opencode-provider.ts` | Wrap as AgentProvider |
| `desktop/src/main/services/storage.ts` | Split into 3 core adapters | Remove Electron deps |
| `desktop/src/main/services/logger.ts` | `core/src/shared/logger.ts` | Move as-is |
| `desktop/src/main/ipc.ts` | Rewrite as thin delegation to core | ~543 -> ~100 lines |
| `desktop/src/main/main.ts` | Update imports | Minimal changes |
| `desktop/bin/concilium.js` | Replaced by `cli/bin/concilium.ts` | Delete |

### Files to DELETE (after migration)

- `desktop/src/main/services/types.ts` — decomposed into core domain
- `desktop/src/main/services/pipeline.ts` — moved to core
- `desktop/src/main/services/runner.ts` — moved to core
- `desktop/src/main/services/openrouter.ts` — moved to core
- `desktop/src/main/services/commands.ts` — split into core
- `desktop/src/main/services/parsers.ts` — moved to core
- `desktop/src/main/services/codex-client.ts` — moved to core
- `desktop/src/main/services/opencode-client.ts` — moved to core
- `desktop/src/main/services/storage.ts` — split into core
- `desktop/src/main/services/logger.ts` — moved to core
- `desktop/bin/concilium.js` — replaced by cli package

### Files UNCHANGED

- `desktop/src/preload/preload.ts`
- `desktop/src/renderer/**` (all React UI)
- `desktop/forge.config.ts`
- `website/**`
- `assets/**`

---

## 9. Migration Checklist

### Pre-migration
- [ ] Set up root `package.json` with workspaces
- [ ] Create `tsconfig.base.json`
- [ ] Verify existing tests pass (`parsers.test.ts`)

### Phase 1: Core extraction (do first, most critical)
- [ ] Create `packages/core/` directory structure and package.json
- [ ] Define all 6 port interfaces
- [ ] Extract domain types (decompose `types.ts` into domain files)
- [ ] Extract `ranking.ts` — pure functions, already tested via pipeline tests
- [ ] Extract `prompts.ts` — pure string-building functions
- [ ] Extract `logger.ts` — already portable
- [ ] Extract `parsers.ts` — already portable, has unit tests
- [ ] Create `AgentProvider` interface
- [ ] Adapt `claude-provider.ts` (from `runner.ts` + `commands.ts`)
- [ ] Adapt `codex-provider.ts` (from `codex-client.ts`)
- [ ] Adapt `opencode-provider.ts` (from `opencode-client.ts`)
- [ ] Create `LlmGateway` interface + `openrouter-gateway.ts` adapter
- [ ] Create `RunRepository` interface + `json-run-repository.ts`
- [ ] Create `ConfigStore` interface + `json-config-store.ts`
- [ ] Create `SecretStore` interface + `plaintext-secret-store.ts`
- [ ] Create `DeliberationEvents` interface
- [ ] Create `DeliberationService` (extract from `ipc.ts`)
- [ ] Create `ConfigService` (extract from `storage.ts`)
- [ ] Create `ModelDiscoveryService` (extract from `runner.ts`)
- [ ] Create barrel export `index.ts`
- [ ] Move parser tests to core, verify pass
- [ ] Build core package, verify zero Electron imports

### Phase 2: CLI (can partly overlap with Phase 3)
- [ ] Create `packages/cli/` structure and package.json
- [ ] Implement Commander entry point with subcommands
- [ ] Implement `run` command — prompt parsing, flag handling
- [ ] Implement `useDeliberation` hook — reducer + event bridge
- [ ] Implement `<RunView>` with `<AgentProgress>` and `<StageIndicator>`
- [ ] Implement `<JurorProgress>` and `<Leaderboard>`
- [ ] Implement `<SynthesisView>` with `<MarkdownRenderer>`
- [ ] Implement `<CostSummary>`
- [ ] Implement JSON formatter (`--json`)
- [ ] Implement plain formatter (auto for piped output)
- [ ] Implement `history` command
- [ ] Implement `config` command (with interactive API key input)
- [ ] Implement `models` command
- [ ] Implement `gui` command (backward compat launcher)
- [ ] Implement XDG path resolution
- [ ] Implement terminal secret store
- [ ] Test end-to-end: `concilium run "test" --json`
- [ ] Test piped input: `echo "test" | concilium run -f - --json`

### Phase 3: Desktop rewire
- [ ] Add `@concilium/core` workspace dependency
- [ ] Create `ElectronSecretStore` adapter
- [ ] Create `ElectronEventBridge` adapter
- [ ] Create `ElectronConfigStore` adapter
- [ ] Create `ElectronRunRepository` adapter
- [ ] Rewrite `ipc.ts` to delegate to core services
- [ ] Update `main.ts` imports
- [ ] Delete `desktop/src/main/services/` directory
- [ ] Delete `desktop/bin/concilium.js`
- [ ] Verify desktop app builds (`npm run build`)
- [ ] Verify desktop app runs end-to-end (all 3 stages)
- [ ] Verify tests pass

### Phase 4: Extensibility
- [ ] Implement `deliberate()` programmatic API in cli/src/index.ts
- [ ] Implement agent provider registry
- [ ] Implement formatter registry
- [ ] Implement pipeline hooks interface
- [ ] Document API for skill authors in README

### Post-migration
- [ ] Update README.md with CLI documentation
- [ ] Update CHANGELOG.md for v2.0.0
- [ ] Update CONTRIBUTING.md for monorepo workflow
- [ ] Update AGENTS.md for new project structure
- [ ] Bump version to 2.0.0
