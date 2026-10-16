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
# See which agent CLIs are installed and signed in
concilium doctor

# Run your first deliberation (no API key needed)
concilium run --agents claude,codex,gemini "Add input validation to the user registration endpoint"
```

Every stage runs through the agent CLIs you have installed (Claude Code, Codex, Gemini CLI, OpenCode), under your own login. An OpenRouter API key is optional: set one only if you want OpenRouter models as jurors or chairman.

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
| `--agents <list>` | Agents to use, comma-separated | The installed, signed-in agent CLIs (see below) |
| `--juror-models <list>` | Jurors, comma-separated council members (see below) | config, else every installed agent CLI |
| `--chairman <model>` | Chairman, one council member (see below) | config, else an installed CLI from another family than most jurors |
| `--cwd <path>` | Project working directory | current directory |
| `--json` | Output full run record as JSON | `false` |
| `--output <file>` | Save the synthesis to a file | — |
| `--no-save` | Don't persist the run to history | `false` |
| `--verbose` | Enable debug logging | `false` |
| `--quiet` | Minimal output (stages and errors only) | `false` |

**Agent specification format:**

The `--agents` flag accepts a comma-separated list. Each entry is either a provider name or `provider:model`:

```bash
# Default: one agent per installed, signed-in agent CLI
concilium run "fix the bug"

# Claude + Codex
concilium run --agents claude,codex "fix the bug"

# Specific models
concilium run --agents claude:opus,codex:gpt-5.2-codex,opencode "fix the bug"
```

Available providers: `claude`, `codex`, `gemini`, `opencode`

Without `--agents`, the run uses one agent per CLI that [`concilium doctor`](#concilium-doctor) reports as installed and signed in with `subscription` or `api-key`, in the order above, each on the CLI's own default model. A CLI with an `unknown` login is left out (Gemini CLI signed in with a Google account shows as `unknown`; name it with `--agents gemini`), and so is a CLI that doctor warns about, such as OpenCode holding a Claude subscription login. When no CLI qualifies, the run exits 1 with an error that points to `concilium doctor` and the [terms-of-use notes](../../docs/research/subscription-tos.md).

Stage 1 agents get a read-only plan brief: they can read the project and search the web, never write files or run shell commands.

**Council member format (jurors and chairman):**

Each juror or chairman is either an agent CLI, written like an agent (`claude`, `codex:gpt-5.2`, `gemini`, `opencode:openai/gpt-5.2`), or an OpenRouter model ID (`openai/gpt-5.2`). CLI members run read-only, in an empty temp directory that holds only their prompt. OpenRouter members need an API key; without one they are skipped, with a note in the run.

With no jurors configured, every installed and signed-in CLI with a known model family (`claude`, `codex`, `gemini`) is a juror; OpenCode is used only when none of those is available. With no chairman configured, the chairman is the installed CLI whose family holds the fewest juror seats (ties go to `gemini`, then `codex`, then `claude`).

```bash
# Jurors and chairman on subscriptions
concilium run --juror-models claude,codex --chairman gemini "fix the bug"

# Mix in an OpenRouter juror (needs OPENROUTER_API_KEY or `config set api-key`)
concilium run --juror-models claude,openai/gpt-5.2 "fix the bug"
```

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

# Run in a different directory
concilium run --cwd ~/projects/backend "add rate limiting to the API"

# Verbose debug output
concilium run --verbose "debug the connection timeout"
```

### CI/CD and automation

When stdout is not a TTY (pipes, CI runners, scripts), the CLI automatically disables the interactive Ink UI and falls back to plain text output. You can also force specific modes:

```bash
# JSON mode — machine-readable, pipe-friendly
concilium run --json "prompt" | jq '.stage3.response'

# Quiet mode — errors only
concilium run --quiet --output result.md "prompt"

# Explicit non-interactive in a GitHub Action
concilium run --json "review this PR" --output review.md
```

**Behavior by mode:**

| Condition | Output style | Notes |
|-----------|-------------|-------|
| TTY (normal terminal) | Live Ink UI with spinners and progress | Default interactive experience |
| `--json` | Full `RunRecord` as JSON to stdout | Best for scripting and pipelines |
| `--quiet` | Errors only | Combine with `--output` to capture synthesis |
| Non-TTY (pipe, CI) | Plain text with unicode status icons | Automatic fallback, no Ink |

**GitHub Actions example:**

```yaml
- name: Run deliberation
  run: |
    npx concilium run --json \
      --agents claude,opencode \
      --output synthesis.md \
      "Review the changes in this PR and suggest improvements" \
      > deliberation.json
```

**Environment variables for CI:**

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Optional — only for OpenRouter jurors or chairman. The agent CLIs must be installed and signed in on the runner. |
| `LOG_LEVEL` | Set to `error` to suppress info logs (default in production) |
| `NODE_ENV` | Set to `production` to default log level to `info` instead of `debug` |

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
| `set api-key [value]` | Set the optional OpenRouter API key (prompts if value omitted) |
| `set chairman <model>` | Set the default chairman (a council member) |
| `set jurors <m1,m2,...>` | Set the default jurors (council members) |
| `reset` | Reset all config to defaults |
| `path` | Print the config directory path |

**Configuration priority** (highest wins, per setting):

1. `run` flags (`--juror-models`, `--chairman`) and the `deliberate()` options (`councilModels`, `chairmanModel`, `apiKey`)
2. Environment variables: `OPENROUTER_API_KEY`, `COUNCIL_MODELS` (jurors), `CHAIRMAN_MODEL`, `OPENROUTER_API_URL`
3. Saved config (`concilium config set ...`); each `config set` changes only its own setting
4. Built-in defaults: no API key, and jurors and chairman chosen from the installed agent CLIs at run time

**Examples:**

```bash
# Set specific council members
concilium config set chairman gemini
concilium config set jurors claude:opus,codex,opencode:openai/gpt-5.2

# OpenRouter members need the API key (interactive prompt)
concilium config set api-key
concilium config set jurors anthropic/claude-sonnet-4,openai/gpt-4.1

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
| `--agent <name>` | Filter to a specific agent (`claude`, `codex`, `gemini`, `opencode`) |
| `--council` | List OpenRouter models available for jurors and chairman (needs an API key) |
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

### `concilium doctor`

Check which agent CLIs (Claude Code, Codex, Gemini CLI, OpenCode) are installed, their versions, and how each is signed in: `subscription`, `api-key`, `none` or `unknown`. It runs each CLI's `--version` and its non-secret status command (`claude auth status`, `codex login status`, `opencode auth list`). For Gemini CLI, which has no status command, it only checks whether `GEMINI_API_KEY` or `GOOGLE_API_KEY` is set. It never reads credential files. A `warning` (shown in the Notes column) flags a login to avoid, such as a Claude subscription inside OpenCode; such a CLI is never a default `run` agent. It exits 0 even when some CLIs are missing, and prints a link to the [terms-of-use notes](../../docs/research/subscription-tos.md).

```
concilium doctor [options]
```

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |

**Examples:**

```bash
# Table of CLIs, versions and auth
concilium doctor

# Installed CLIs only
concilium doctor --json | jq '.clis[] | select(.installed)'
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
| `OPENROUTER_API_KEY` | Optional OpenRouter API key, for OpenRouter jurors or chairman (takes priority over saved config) |
| `COUNCIL_MODELS` | Comma-separated jurors (council members) |
| `CHAIRMAN_MODEL` | Chairman (a council member) |
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
  councilModels: ['claude', 'codex:gpt-5.2'],
  chairmanModel: 'gemini',
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
| `agents` | `Array<{ provider, model? }>` | No | Agent list (defaults to the installed, signed-in agent CLIs, as for `run`; rejects when there are none) |
| `apiKey` | `string` | No | OpenRouter API key, only for OpenRouter members (overrides env and saved config) |
| `councilModels` | `string[]` | No | Jurors as council members (overrides env and saved config) |
| `chairmanModel` | `string` | No | Chairman as a council member (overrides env and saved config) |
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

1. **Stage 1 — Parallel Execution:** Multiple coding agents (Claude Code, Codex, Gemini CLI, OpenCode) receive the same prompt and research the project directory read-only. Each produces an implementation plan.

2. **Stage 2 — Blind Peer Review:** Jurors (agent CLIs, or OpenRouter models when an API key is set) evaluate all agent responses anonymously. Each juror ranks the responses and provides reasoning. Rankings are aggregated using average rank scoring.

3. **Stage 3 — Synthesis:** A chairman model receives all agent responses plus the aggregate rankings, then synthesizes a single answer that combines the best elements from the top-ranked responses.
