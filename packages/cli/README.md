# @concilium/cli

Terminal interface for the Concilium multi-LLM deliberation platform. Run deliberations, manage configuration, browse history, and discover models — all from the command line.

## Installation

Install globally from npm:

```bash
npm install -g @concilium/cli
```

Then use `concilium` anywhere:

```bash
concilium run "your prompt"
```

### From source

If you're developing from the monorepo:

```bash
git clone https://github.com/matiasdaloia/concilium.git
cd concilium
npm install
npm run dev -w @concilium/cli -- run "your prompt"   # dev mode (tsx, no build needed)
```

## Quick start

```bash
# Set your OpenRouter API key (one-time)
concilium config set api-key sk-or-v1-...

# Run your first deliberation
concilium run "Add input validation to the user registration endpoint"
```

## Command reference

### `concilium run`

Run a full deliberation pipeline: agents execute in parallel, jurors rank the results, and a chairman synthesizes the final answer.

```
concilium run [prompt...] [options]
```

**Arguments:**

| Argument | Description |
|----------|-------------|
| `prompt` | The prompt to deliberate on (multiple words joined automatically) |

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-f, --file <path>` | Read prompt from a file (`-` for stdin) | — |
| `--agents <list>` | Agents to use, comma-separated | `opencode,opencode` |
| `--juror-models <list>` | Juror model IDs (comma-separated OpenRouter IDs) | config default |
| `--jurors <n>` | Number of juror models | 3 |
| `--chairman <model>` | Chairman model (OpenRouter model ID) | config default |
| `--stage1-only` | Run agents only, skip council review and synthesis | `false` |
| `--cwd <path>` | Project working directory | current directory |
| `--json` | Output full run record as JSON | `false` |
| `--format <type>` | Output format: `interactive`, `md`, `plain` | `interactive` |
| `--output <file>` | Save the synthesis to a file | — |
| `--no-save` | Don't persist the run to history | `false` |
| `--verbose` | Enable debug logging | `false` |
| `--quiet` | Minimal output (stages and errors only) | `false` |

**Agent specification format:**

The `--agents` flag accepts a comma-separated list. Each entry is either a provider name or `provider:model`:

```bash
# Two default opencode agents
concilium run "fix the bug"

# Claude + Codex
concilium run --agents claude,codex "fix the bug"

# Specific models
concilium run --agents claude:opus,codex:gpt-5.2-codex,opencode "fix the bug"
```

Available providers: `claude`, `codex`, `opencode`

**Examples:**

```bash
# Read prompt from file
concilium run -f prompt.md

# Pipe from stdin
echo "Explain the auth flow" | concilium run -f -

# JSON output for scripting / piping
concilium run --json "design a cache layer" | jq '.stage3.response'

# Save synthesis directly to a file
concilium run --output solution.md "migrate the database schema"

# Agents only (skip peer review and synthesis)
concilium run --stage1-only "generate test fixtures for the user model"

# Run in a different directory
concilium run --cwd ~/projects/backend "add rate limiting to the API"

# Verbose debug output
concilium run --verbose "debug the connection timeout"
```

### `concilium history`

Browse and view past deliberation runs.

```
concilium history [run-id] [options]
```

| Flag | Description |
|------|-------------|
| `--last` | Show the most recent run |
| `--synthesis` | Print only the synthesis text (combine with `--last`) |
| `--json` | Output as JSON |

**Examples:**

```bash
# List all runs
concilium history

# View a specific run
concilium history a1b2c3d4-...

# Quickly grab the last synthesis
concilium history --last --synthesis

# Pipe last result as JSON
concilium history --last --json | jq '.metadata.aggregateRankings'
```

### `concilium config`

Manage persistent configuration.

```
concilium config [subcommand]
```

| Subcommand | Description |
|------------|-------------|
| `show` | Display current configuration |
| `show --json` | Output config as JSON |
| `set api-key [value]` | Set the OpenRouter API key (prompts if value omitted) |
| `set chairman <model>` | Set the default chairman model |
| `set jurors <m1,m2,...>` | Set the default juror models |
| `reset` | Reset all config to defaults |
| `path` | Print the config directory path |

**Configuration priority** (highest wins):

1. Environment variable `OPENROUTER_API_KEY`
2. CLI flags (`--chairman`, `--juror-models`)
3. Saved config (`concilium config set ...`)
4. Built-in defaults

**Examples:**

```bash
# Interactive API key prompt
concilium config set api-key

# Set specific models
concilium config set chairman anthropic/claude-sonnet-4
concilium config set jurors anthropic/claude-sonnet-4,openai/gpt-4.1,google/gemini-2.5-pro

# Check current config
concilium config show

# Get config dir for backup/scripting
concilium config path
# => ~/.config/concilium
```

### `concilium models`

Discover available models from agents and OpenRouter.

```
concilium models [options]
```

| Flag | Description |
|------|-------------|
| `--agent <name>` | Filter to a specific agent (`claude`, `codex`, `opencode`) |
| `--council` | List OpenRouter models available for jurors and chairman |
| `--json` | Output as JSON |

**Examples:**

```bash
# Discover all installed agent models
concilium models

# Only Claude models
concilium models --agent claude

# Browse OpenRouter catalog
concilium models --council

# JSON for scripting
concilium models --council --json | jq '.[].id'
```

## Configuration

### File locations

The CLI follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/):

| Purpose | Default path | Override env var |
|---------|-------------|-----------------|
| Config | `~/.config/concilium/` | `XDG_CONFIG_HOME` |
| Data (runs) | `~/.local/share/concilium/` | `XDG_DATA_HOME` |
| Cache | `~/.cache/concilium/` | `XDG_CACHE_HOME` |

### Environment variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key (takes priority over saved config) |
| `XDG_CONFIG_HOME` | Override config directory |
| `XDG_DATA_HOME` | Override data directory |
| `XDG_CACHE_HOME` | Override cache directory |

## Programmatic API

The CLI package exports a `deliberate()` function for use in scripts, agent skills, or other Node.js programs.

```typescript
import { deliberate } from '@concilium/cli';

const result = await deliberate({
  prompt: 'Add error handling to the payment service',
  cwd: '/path/to/project',
  agents: [
    { provider: 'claude' },
    { provider: 'opencode' },
  ],
  apiKey: 'sk-or-v1-...',
  councilModels: ['anthropic/claude-sonnet-4', 'openai/gpt-4.1'],
  chairmanModel: 'anthropic/claude-sonnet-4',
  onProgress: (event) => console.log(event),
  save: true,
});

console.log(result.stage3?.response);
```

### `deliberate(options)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `prompt` | `string` | Yes | The deliberation prompt |
| `cwd` | `string` | No | Working directory (defaults to `process.cwd()`) |
| `agents` | `Array<{ provider, model? }>` | No | Agent list (defaults to 2x opencode) |
| `apiKey` | `string` | No | OpenRouter API key (overrides config) |
| `councilModels` | `string[]` | No | Juror model IDs |
| `chairmanModel` | `string` | No | Chairman model ID |
| `onProgress` | `EventHandler` | No | Callback for progress events |
| `save` | `boolean` | No | Persist run to history (default: `true`) |

**Returns:** `Promise<RunRecord>` — the full deliberation result including all stages, rankings, costs, and the synthesized answer.

### Event handler

The `onProgress` callback receives events with a `type` field:

```typescript
type EventHandler = (event: ProgressEvent) => void;

// Event types:
{ type: 'stage-change', stage: number, summary: string }
{ type: 'agent-status', agentKey: string, status: string, name?: string }
{ type: 'agent-event', agentKey: string, event: ParsedEvent }
{ type: 'juror-status', model: string, status: string }
{ type: 'juror-chunk', model: string, chunk: string }
{ type: 'juror-complete', model: string, reasoning: string, rankings: ... }
{ type: 'synthesis-start' }
{ type: 'complete', record: RunRecord }
{ type: 'error', error: string }
```

## Architecture

The CLI is built on `@concilium/core`, the framework-agnostic domain library that also powers the desktop app. This means identical deliberation logic, ranking algorithms, and prompt engineering regardless of which interface you use.

```
@concilium/core (domain logic, ports, adapters)
       │
       ├── @concilium/cli (Commander + Ink terminal UI)
       │       ├── commands/      CLI subcommands
       │       ├── ui/            Ink React components (live progress)
       │       ├── adapters/      XDG paths, terminal secrets
       │       └── formatters/    JSON, plain, markdown output
       │
       └── desktop (Electron app)
               └── adapters/      IPC bridge, safeStorage encryption
```

### Hexagonal architecture

`@concilium/core` uses a ports-and-adapters (hexagonal) pattern. The CLI and desktop each provide their own implementations of the port interfaces:

| Port | CLI adapter | Desktop adapter |
|------|------------|----------------|
| `SecretStore` | `PlaintextSecretStore` (base64) | `ElectronSecretStore` (OS keychain via `safeStorage`) |
| `ConfigStore` | `JsonConfigStore` (XDG paths) | `JsonConfigStore` (Electron `userData`) |
| `RunRepository` | `JsonRunRepository` (XDG data dir) | `JsonRunRepository` (Electron `userData`) |
| `DeliberationEvents` | Callback bridge / Ink reducer | IPC event bridge (`webContents.send`) |

### Three-stage pipeline

1. **Stage 1 — Parallel Execution:** Multiple coding agents (Claude, Codex, OpenCode) receive the same prompt and work independently in the project directory. Each produces a complete solution.

2. **Stage 2 — Blind Peer Review:** Juror models (via OpenRouter) evaluate all agent responses anonymously. Each juror ranks the responses and provides reasoning. Rankings are aggregated using average rank scoring.

3. **Stage 3 — Synthesis:** A chairman model receives all agent responses plus the aggregate rankings, then synthesizes a single answer that combines the best elements from the top-ranked responses.
