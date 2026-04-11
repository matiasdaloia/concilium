# CLI Reference

## Installation

```bash
npm install -g @concilium/cli
```

## Commands

### `concilium verify`

Run multi-agent code review on a pull request with confidence scoring.

```bash
concilium verify --pr <url> [options]
```

**Required** (one of):
- `--pr <url>` — GitHub PR URL (e.g. `https://github.com/org/repo/pull/123`)
- `--repo <owner/repo> --pr-number <n>` — Alternative decomposed form

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--models <list>` | Per-preset defaults | OpenRouter model IDs for review agents (comma-separated) |
| `--preset <fast\|balanced\|thorough>` | `fast` | Model preset (determines default models) |
| `--juror-models <list>` | Config default | Juror models for ranking (comma-separated) |
| `--chairman <model>` | Config default | Chairman model for synthesis |
| `--threshold <0-100>` | `70` | Confidence threshold for PASS/FAIL |
| `--format <json\|text\|markdown>` | `text` (TTY) / `json` (CI) | Output format |
| `--output <file>` | — | Save JSON report to file |
| `--no-post` | `false` | Skip posting review comment to GitHub |
| `--no-save` | `false` | Don't persist to run history |
| `--focus-files <list>` | — | Comma-separated files to focus on |
| `--custom-instructions <text>` | — | Additional review instructions |
| `--cwd <path>` | `.` | Working directory |
| `--verbose` | `false` | Debug logging |
| `--quiet` | `false` | Minimal output (stderr only on errors) |

**Exit codes:**

| Code | Meaning |
|------|---------|
| `0` | PASS — confidence ≥ threshold |
| `1` | FAIL — confidence < threshold |
| `2` | Error — config, API, or pipeline failure |

**Examples:**

```bash
# Basic review
concilium verify --pr https://github.com/org/repo/pull/42

# Stronger models with high threshold
concilium verify --pr https://github.com/org/repo/pull/42 --preset balanced --threshold 80

# Custom models
concilium verify --pr https://github.com/org/repo/pull/42 \
  --models "anthropic/claude-sonnet-4.5,openai/gpt-5.2"

# JSON output to file
concilium verify --pr https://github.com/org/repo/pull/42 \
  --format json --output report.json

# Focus on specific files
concilium verify --pr https://github.com/org/repo/pull/42 \
  --focus-files "src/auth/,src/payments/"

# Review without posting comment
concilium verify --pr https://github.com/org/repo/pull/42 --no-post
```

---

### `concilium run`

Run a full deliberation pipeline on any coding prompt.

```bash
concilium run [prompt...] [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `-f, --file <path>` | — | Read prompt from file (`-` for stdin) |
| `--agents <list>` | 2x opencode | Agents to use (e.g. `claude,codex,opencode:model`) |
| `--juror-models <list>` | Config default | Juror models |
| `--jurors <n>` | — | Number of default juror models |
| `--chairman <model>` | Config default | Chairman model |
| `--stage1-only` | `false` | Skip council stages |
| `--cwd <path>` | `.` | Working directory |
| `--json` | `false` | JSON output |
| `--format <type>` | `interactive` | Output format: `interactive`, `md`, `plain` |
| `--output <file>` | — | Save synthesis to file |
| `--no-save` | `false` | Don't persist to history |
| `--verbose` | `false` | Debug logging |
| `--quiet` | `false` | Minimal output |

**Examples:**

```bash
# Basic deliberation
concilium run "Add rate limiting to the API endpoints"

# With specific agents
concilium run --agents "claude,opencode" "Refactor auth to use JWT"

# From a file
concilium run --file prompt.txt

# JSON output for scripting
concilium run --json "Explain the payment flow" | jq '.stage3.response'
```

---

### `concilium history`

Browse past deliberation runs.

```bash
concilium history [run-id] [options]
```

| Flag | Description |
|------|-------------|
| `--last` | Show the most recent run |
| `--synthesis` | Print only the synthesis text |
| `--json` | Output as JSON |

---

### `concilium config`

Manage configuration.

```bash
concilium config <subcommand> [options]
```

| Subcommand | Description |
|-----------|-------------|
| `show [--json]` | Display current config |
| `set api-key <key>` | Store OpenRouter API key |
| `set chairman <model>` | Set default chairman model |
| `set jurors <models>` | Set default juror models (comma-separated) |
| `reset` | Reset to defaults |
| `path` | Print config file location |

---

### `concilium models`

Discover available models.

```bash
concilium models [options]
```

| Flag | Description |
|------|-------------|
| `--agent <name>` | Filter by agent provider |
| `--council` | Browse OpenRouter catalog |
| `--json` | JSON output |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key (overrides stored key) |
| `GITHUB_TOKEN` | GitHub token for posting review comments |
| `LOG_LEVEL` | Logging level: `debug`, `info`, `warn`, `error` |
