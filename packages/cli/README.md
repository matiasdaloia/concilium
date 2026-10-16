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

### `concilium code`

Have agent CLIs write code for a task, side by side. Concilium pins the repo's `HEAD` as the base, gives each agent its own git worktree on branch `concilium/<run-id>/<candidate-id>` (under `$XDG_CACHE_HOME/concilium/worktrees/`, never inside your repo), and runs them in parallel with a write-mode brief: read, write and shell, limited by what each CLI's driver allows (Gemini CLI gets no shell, Codex runs in its workspace-write sandbox). When an agent finishes, Concilium commits whatever it left uncommitted on its branch as `concilium`, including after a failure, so you can look at partial work. A failing candidate does not stop the others. Your checkout, index and branch are never touched.

Before any candidate starts, the run is framed:

- **Task type.** `--type` picks one of `bugfix`, `feature`, `refactor`, `perf` or `prototype`. Without it, a keyword classifier guesses from the task (`fix`, `flaky` → `bugfix`; `slow`, `faster` → `perf`; `refactor`, `rename` → `refactor`; `prototype`, `spike` → `prototype`; anything else → `feature`) and records why. The type selects a fixed playbook, whose ordered steps and verification expectations go into every candidate's brief verbatim. A `bugfix` starts by reproducing the bug with a failing test, a `refactor` by pinning behavior with a characterization test, a `perf` task by measuring a baseline.
- **Rubric.** The first agent's CLI gets one read-only run to tailor the playbook's default criteria to the task: 3 to 6 criteria, each with a name, a description, a weight and what settles it (`gate`, `adversarial` or `judgment`). If that run fails or its answer is not a valid rubric, the playbook's defaults are used, with a note. The rubric is frozen with a sha256 before any candidate starts, and shown with its hash before the candidates and in the summary. Candidates never see it: their brief holds the task and the playbook only.

The type, the reason it was picked, and the frozen rubric (`taskType` and `rubric`) are saved in the run record.

After the candidates finish, every candidate is verified against the base (skip it with `--no-verify`):

- **Gates.** Concilium checks out the base in one more worktree (`concilium/<run-id>/base`) and decides the gates from it, so a candidate cannot change them: the commands in `.concilium/verify.yaml` if the repo has one, otherwise the ones it detects (`package.json` scripts named `typecheck`, `lint` and `test`, the same `Makefile` targets, `go vet ./...` and `go test ./...` for a Go module, `python -m pytest` for a pytest project, `cargo test`). Each gate runs once on the base, then on each candidate's head, one at a time, with a 10-minute limit. When a worktree has a `package-lock.json` and no `node_modules`, `npm ci` runs first. A gate that already fails on the base is a baseline failure and does not count against anyone; only new failures do. The record keeps, per gate, the command, the SHA it ran at, the exit code, the duration and the last 8000 characters of output.
- **Integrity checks** on each candidate's diff against the base. Deleting or moving a test file, adding `.skip`/`.only`/`xit`/`@Disabled`/`t.Skip`/`@pytest.mark.skip` and similar markers, or lowering a coverage threshold disqualifies the candidate. Editing gate configuration (lint configs, `tsconfig`, test runner configs, CI files, `.concilium/`, the `test`/`lint`/`typecheck` scripts) and adding dependencies (`package.json`, `requirements*.txt`, `go.mod`, `Cargo.toml`) are penalties. Each finding keeps the offending hunk.

A candidate is `PASS` with no new gate failure and no finding, `DISQUALIFIED` when it weakened the tests, and `ISSUES` otherwise. Gates run the target repo's own code, and the code the candidates wrote, on your machine, without a sandbox; only credentials (variables ending in `KEY`, `TOKEN`, `SECRET`, `PASSWORD`) and npm's settings are removed from their environment.

`.concilium/verify.yaml`, committed in the target repo, replaces the detected gates when it lists `gates`, and the install step when it sets `install`:

```yaml
install: npm ci          # optional; false installs nothing
gates:
  typecheck: npm run typecheck
  test:
    run: npm test
    timeout: 900         # seconds, default 600
```

Then comes the adversarial round (skip it with `--no-adversarial`; it needs the gates, and at least 2 candidates with a branch). Each model family among the candidates (Claude, OpenAI, Google; OpenCode counts as its own) gets one fresh adversary: the first candidate's CLI of that family, in its own scratch worktree from the base (`concilium/<run-id>/adv-<family>`), with the other families' diffs as read-only patch files. It writes up to 5 tests that a correct solution passes and the base fails, aimed at the task and at the weak spots it sees, and lists them in `concilium-adversarial.json` at the root of its worktree, each with the part of the task it enforces (`specClause`). Entries that are not existing test files or that name no clause are dropped with a note. Each test then runs under the repo's test gate (`test`, `npm:test`, `make:test`, `go:test`, `pytest` or `cargo:test`) on the base and on every candidate: its files are copied into that worktree for the run and removed after, so no branch changes. A lane whose suite already fails without the test is not run and gets `error`. The result is the survival matrix, and the validity rule sorts each test:

| Validity | When | Counts |
|---|---|---|
| `evidence` | fails on the base, passes on at least one candidate of another family than the test's author | yes |
| `own-family-only` | fails on the base, passes only on candidates of the author's family | no |
| `quarantined` | fails on the base and on every candidate | no; kept for the judges |
| `vacuous` | passes on the base of a `bugfix` | no; dropped |
| `regression-guard` | passes on the base of any other type | yes |
| `unrunnable` | could not run on the base | no |

A candidate's survival is how many of the counted tests by other families it passes; its own family's tests carry no weight for it. The test gate runs the tests only if its command picks up new test files (a runner such as `npm test` with vitest or jest does; `node sum.test.js` does not).

Last, every candidate gets a report and the candidates are ranked on the evidence:

- **Report.** `PASS`, `ISSUES` or `BLOCKED`, with the branch, the base SHA, the head SHA, the evidence (how the agent ended, each gate's verdict at its SHA, the integrity findings, the survival, the playbook steps) and a short reason. `BLOCKED` means there is nothing to judge: no branch head, or no change. `ISSUES` means some evidence is against it, including a final message that does not list every playbook step as done or skipped (a line starting with the step's number and saying `done` or `skipped`). Anything else is `PASS`. What the agent says about its own work is never evidence.
- **Ranking.** Disqualified candidates go last (blocked ones after them), then fewer new gate failures, then a higher survival rate (no counted test counts as surviving all), then fewer integrity penalties. Only an exact tie between candidates that can win goes to a judge (skip it with `--no-judge`): one read-only run of an installed, signed-in CLI whose model family wrote none of the tied candidates, on its own default model. A judge of a tied family is allowed only when no usable CLI is of another family (OpenCode, of unknown family, never counts as another one): then the first usable CLI judges, and the run flags it as a same-family judge with the reason on the judgment (`sameFamily`, `sameFamilyReason`), as a `Warning:` line under the judge in the summary, and as a `judge` evidence line in each tied candidate's report. Before it runs, the rubric must still match the sha256 it was frozen with; otherwise the judge is `BLOCKED`. The judge sees the task, the frozen rubric, and each tied candidate under a letter with its diff against the base and its evidence, never which agent wrote it. It answers JSON with a 0 to 10 score and a one-line reason per candidate and criterion; a missing, duplicate or out-of-range score blocks it. The weighted totals order the tie and nothing else: the judge never moves a candidate past one that is better on the evidence.
- **Winner.** The candidate ranked first. When candidates are still tied at the top after the judge (it is `BLOCKED`, `--no-judge` is set, or it scored them the same), the one with the smallest diff wins: fewest lines added plus removed, then fewest files changed, then the first candidate id. It ranks 1, the others of that tie share rank 2, and the reason starts with `tie broken by smallest diff`. There is no winner only when every candidate is blocked or disqualified (or there are none).

Then comes synthesis (skip it with `--no-synthesis`; it is skipped with fewer than 2 candidates, without a winner, without the gates, and for a `prototype`). The winner is the base: `concilium/<run-id>/integration` starts at its head, in its own worktree. Candidates that are blocked or disqualified drop out. One read-only run of a CLI (picked as the judge is, from another family than the base and the other candidates when one is usable) reads the base and each other candidate under a letter, with its diff and evidence, and names at most 2 grafts per candidate: the files (and optionally the hunk) of that candidate's diff the idea comes from, an instruction, and why. Grafts naming a file outside that diff are dropped with a note. Each graft is then folded in by hand by a fresh run of the winner's CLI and model in the integration worktree, with the source candidate's diff as a read-only patch file, and Concilium commits it: one commit per graft. After each graft the gates run on the integration head, and the valid adversarial tests (`evidence` and `regression-guard`) run there when the test gate passes. A graft is rejected, and its commit reverted, when a gate or valid test that passed before it fails after it, when it weakens a test (a Tier 0 disqualification), or when the integrator fails or changes nothing; the failing runs are kept as its evidence. Last, the integration branch is written as `result.patch` (`git diff --binary <baseSha>..<integration head>`) and checked with `git apply --check` against your repo's current `HEAD` (on a scratch index; your checkout is not touched): it is mergeable when it applies. `synthesis.md` lists the base, the applied grafts with their source candidate, the rejected grafts with their evidence, the dropouts, the checks at the integration head and the result. Both files go next to `run.json`.

Before synthesis, Concilium checks whether the candidates diverge, because divergence means the task can be read more than one way and a blend would hide that. It looks only at candidates that are neither blocked nor disqualified, and only when there are at least 2 of them: none of them passes the gates (each has a new gate failure); or, among those that pass the gates, each fails at least one adversarial test written by another family that fails on the base and passes on some candidate (`evidence`, `own-family-only` or `regression-guard`), and no two fail the same test, so none dominates; or judges of the same tie pick different bases (today one judge runs per tie, so this one cannot fire yet). On divergence the run ends with `status: "reframe-needed"`: nothing is grafted, no integration branch is made and no `result.patch` is written. One read-only run of the first agent's CLI (the one that framed the rubric) turns each line in conflict (the `specClause` the split tests quote, or the gate no one passes) into a question for you; every line it leaves out, or all of them when it gives no usable answer, gets a question written from the evidence. The divergence, the lines in conflict with what each candidate did, and the questions go to `reframe.md` next to `run.json`, to `reframe` on the record and to the summary. Answer them, restate the task, and run again. `--no-synthesis` skips this check, since there is no blend to stop.

It prints one row per candidate (status, verification verdict, files changed, lines added and removed, commits, duration, tokens), a table of gate results per lane (`base`, then each candidate), the integrity findings, the adversaries, the survival matrix with each test's validity and clause, each candidate's survival, the ranking with the judge's totals, the winner, each candidate's report, the grafts, the integration branch, the patch path and whether it is mergeable (or, when the candidates diverge, the lines in conflict and the questions), and the commands to inspect each branch and clean up. The run record (with `report` on each candidate, and `status`, `ranking`, `synthesis` and `reframe` on the run) is saved to `$XDG_DATA_HOME/concilium/runs/<run-id>/run.json`. The worktrees stay until you run `concilium gc --run <run-id>`, which keeps the integration branch. Nothing is merged into your branch. It exits 1 when no candidate finished `ok`, and 2 when the run ends in `reframe-needed`.

```
concilium code [options] [task...]
```

| Flag | Description |
|------|-------------|
| `--agents <list>` | Candidate agents, comma-separated, each `cli[:model]` (`claude,codex`, `claude:opus,codex:gpt-5.2-codex`). Default: the installed, signed-in agent CLIs, as for `run` |
| `--type <type>` | Task type, which picks the playbook and the default rubric: `bugfix`, `feature`, `refactor`, `perf`, `prototype`. Default: guessed from the task |
| `--cwd <path>` | Directory of the git repo to work on (default: current directory) |
| `--include-dirty` | Start every candidate from your uncommitted changes too (snapshotted to `refs/concilium/<run-id>/snapshot`). Without it a dirty tree is refused |
| `--timeout <minutes>` | Wall-clock limit per candidate and per adversary (default: 30) |
| `--no-verify` | Skip the gates and the integrity checks after the candidates finish, and with them the adversarial round |
| `--no-adversarial` | Skip the adversarial round (one adversary per model family writes tests that run on the base and every candidate) |
| `--no-judge` | Do not ask a judge CLI (from another model family when one is usable) to order candidates tied on the evidence; a tie at the top goes to the smallest diff |
| `--no-synthesis` | Do not graft ideas from the other candidates into the winner on the integration branch, and write no `result.patch` or `synthesis.md`. Also skips the divergence check that ends a run in `reframe-needed` (exit 2) |
| `--json` | Print the run record as JSON to stdout (progress and errors go to stderr) |

**Examples:**

```bash
# Two candidates on the current repo
concilium code "add input validation to sum() with a test" --agents claude,codex

# A bug fix: every candidate follows the bugfix playbook
concilium code "sum() crashes on empty input" --type bugfix --agents claude,codex

# Compare a candidate with the base, then clean up
git diff <base>..concilium/<run-id>/claude
concilium gc --run <run-id>

# Head SHA and diffstat of each candidate
concilium code "fix the flaky retry test" --json | jq '.candidates[] | {candidateId, status, headSha, diffStat}'

# New gate failures and integrity findings of each candidate
concilium code "fix the flaky retry test" --json | jq '.candidates[] | {candidateId, verdict: .verification.status, newFailures: .verification.newFailures, integrity: [.verification.integrity[].message]}'

# Each test's validity and survival, and how each candidate fared
concilium code "sum() must reject non-numbers" --json | jq '{tests: [.adversarial.tests[] | {id, validity, specClause}], survival: .adversarial.survival}'

# The winner, and each candidate's report
concilium code "sum() must reject non-numbers" --json | jq '{winner: .ranking.winner, reason: .ranking.reason, reports: [.candidates[] | {candidateId, status: .report.status, headSha: .report.headSha, reason: .report.reason}]}'

# The integration branch, its patch and the grafts; apply the patch once you have read synthesis.md
concilium code "sum() must reject non-numbers" --json | jq '.synthesis | {branch, patchPath, mergeable, grafts: [.grafts[] | {id, candidateId, status, reason}]}'
git apply ~/.local/share/concilium/runs/<run-id>/result.patch

# When the candidates diverge (exit 2): the lines in conflict and the questions to answer before running again
concilium code "add slugify()" --json | jq 'select(.status == "reframe-needed") | {divergence: [.reframe.divergence[] | {trigger, clauses: [.conflicts[].clause]}], questions: .reframe.questions}'

# Rank only: no grafts, no integration branch
concilium code "add a flag" --no-synthesis

# Gates, no adversarial round
concilium code "rename the parser module" --type refactor --no-adversarial

# Candidates only, no gates
concilium code "try a new parser" --type prototype --no-verify
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

### `concilium gc`

Remove the git worktrees, the `concilium/<run-id>/*` branches and the `refs/concilium/<run-id>/*` scratch refs of finished runs. Candidate worktrees live under `$XDG_CACHE_HOME/concilium/worktrees/<repo-hash>/<run-id>/<candidate-id>`, outside your repo. A run whose process was killed counts as finished. A run whose process is still alive is skipped. `gc` never deletes a branch outside `concilium/`, and keeps the `concilium/<run-id>/integration` branch until you delete it. Running it twice leaves the same state. It exits 1 if a step failed (for example a `concilium/` branch checked out in your own checkout).

```
concilium gc [options]
```

| Flag | Description |
|------|-------------|
| `--run <id>` | Only this run |
| `--dry-run` | Show what would be removed, change nothing |

**Examples:**

```bash
# See what would be removed
concilium gc --dry-run

# Clean up one run
concilium gc --run 2026-10-16-a1b2
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
