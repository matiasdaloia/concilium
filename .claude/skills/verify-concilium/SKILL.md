---
name: verify-concilium
description: Verify a change to the Concilium repo (core, CLI, desktop) offline. Use before committing or declaring a Concilium change done, when deciding which test covers a feature, or when adding a test for new behavior.
---

# Verify Concilium

Every check here runs offline. No API keys, no network, no real `claude`/`codex`/`gemini`/`opencode` binaries, and nothing reads or writes your home config.

## Commands

Run from the repo root. This is the same sequence CI runs (`.github/workflows/ci.yml`).

```bash
npm ci                                       # clean install from the lockfile
npm run build                                # core, then cli (tsc)
npm run typecheck                            # core + cli project refs and tests, desktop --noEmit
npm test                                     # vitest in cli, core, desktop, then the repo invariants
npm run lint -w concilium                    # eslint in desktop (warnings are allowed, errors are not)
node packages/cli/dist/bin/concilium.js --help   # the built CLI starts
```

All six commands must exit 0. A change is not verified until they do. To be sure nothing depends on your working tree, run them in a fresh clone:

```bash
rm -rf /tmp/concilium-verify
git clone --branch <branch> <repo> /tmp/concilium-verify && cd /tmp/concilium-verify
```

Faster loops while working:

```bash
npm run test -w @concilium/core              # core only
npm run test -w @concilium/cli               # cli only (needs a built core)
npm run test -w concilium                    # desktop only (needs a built core)
npm run test:repo                            # repo invariants only (needs a built core)
npx vitest run packages/core/src/services/deliberation-service.test.ts
npx vitest run packages/core/src/domain/code-council/   # playbooks, classifier, rubric
```

The CLI tests, the desktop tests and the repo invariants import `@concilium/core` (and `@concilium/core/providers`) from `packages/core/dist`. After changing core, run `npm run build:core` before them.

## Feature map

### Plan council (M0, M1.6)

| Feature | Test | What it pins |
|---|---|---|
| CLI command surface | `packages/cli/bin/concilium.test.ts` | `--help`, `run --help` and `code --help` text (snapshots in `bin/__snapshots__/`), every command is registered, `--version` matches `package.json`, `models --agent` offers every registered provider |
| Plan council with no API key, end to end | same file | `run --json --no-save --agents claude,codex,gemini` with only fake `claude`/`codex`/`gemini` scripts on `PATH` and no `OPENROUTER_API_KEY` exits 0 and completes Stage 1, 2 and 3: three plans, the installed CLIs as jurors, `gemini` as chairman, no notes. All seven CLI runs (3 agents, 3 jurors, 1 chairman) use the CLI's read-only flag (`--permission-mode=plan`, `--sandbox=read-only`, `--approval-mode=default`) |
| Default Stage 1 agents from detection | same file | `run` without `--agents` runs one agent per installed, signed-in fake CLI; with no CLI signed in it exits 1 and points to `concilium doctor` and the terms doc |
| Clean `--json` stdout | same file | `run --json` with no runnable agent (empty `PATH`) exits 1, prints `{"error": ...}` on stderr and nothing on stdout. Log lines go to stderr. |
| `concilium doctor` | same file | `doctor --json` with one fake CLI on `PATH`: a row per registered CLI (`claude`, `codex`, `gemini`, `opencode`), installed/version/auth, exit 0 with CLIs missing, terms-of-use link; the table with no CLI installed |
| CLI cost labels | `packages/cli/src/ui/components/CostSummary.test.ts` | Ink output (`renderToString`): an agent CLI cost (Claude Code `total_cost_usd`, OpenCode `cost`) is labelled `est. API-equivalent` in the live agent line and in the cost summary (Agents header, Total row); no label when no agent reported a cost |
| Full deliberation (Stage 1 → 2 → 3) on fake CLIs | `packages/core/src/services/deliberation-service.test.ts` | A real `DeliberationService` and `CliCouncilGateway` over `FakeCliDriver`s, no API key: agent plans become Stage 1, CLI jurors (`claude`, `codex:gpt-5.2`) rank the anonymized plans to the right leaderboard, the `gemini` chairman's output becomes Stage 3, stage events fire 1→2→3, the run record is persisted and listed in history |
| Stage 1 agent briefs | same file | Each agent gets a read-only plan brief (`mode: 'plan'`, no `write`/`shell`) with the prompt, in the run `cwd`, with its model; inline (base64) images are written to temp files listed in the brief and removed after the run |
| Council briefs | same file | Juror and chairman runs are read-only plan briefs (`allowedActions: ['read']`) outside the project dir; CLI jurors and chairman get no API price (`estimatedCost: null`) even when OpenRouter lists a matching id |
| Degraded runs | same file | One surviving agent: ranking skipped, its plan is the answer, the failed agent keeps its error. A juror whose CLI fails is dropped with `Ranking model failed: <spec>` and the others still synthesize. No juror available: Stage 2/3 skipped with a note. All agents fail: error event, rejected promise, nothing persisted |
| Agents with the same provider and model | same file | Two default OpenCode agents get distinct names (`opencode`, `opencode #2`) and two leaderboard rows |
| Subscription agent cost | same file | CLI agents get `costPer1kTokens: null` in model snapshots, never API per-token prices |
| Council member specs and default council | `packages/core/src/domain/council/council-members.test.ts` | `cli[:model]` specs (`claude`, `codex:gpt-5.2`, `opencode:openai/gpt-5.2`) vs OpenRouter ids; model families; with nothing configured every usable CLI with a family is a juror and the chairman is the CLI whose family holds the fewest juror seats (ties: gemini, codex, claude); OpenCode only as a last resort; configured members kept; OpenRouter members without a key skipped with a note and replaced by the installed CLIs; empty council with a note when nothing is usable |
| CLI council gateway | `packages/core/src/adapters/cli/cli-council-gateway.test.ts` | A CLI juror runs a read-only plan brief pointing at `council-prompt.md` in a temp dir (removed afterwards), with the spec's model or the CLI default; streamed chunks and usage come back; a failed, rate-limited or missing CLI is `null`; OpenRouter ids go to OpenRouter only when it is configured; an aborted run aborts the juror |
| Provider registry and composition root | `packages/core/src/services/create-concilium.test.ts` | The registry is `claude`, `codex`, `gemini`, `opencode`; `createDrivers` builds one CLI driver per entry in registry order; saved agent instances accept every registered provider and drop unknown ones; model discovery offers the registry models and the models OpenCode lists, and none when listing fails |
| Default agents (`defaultAgentInstances`) | same file | One agent per CLI whose `detect()` says installed and signed in (`subscription` or `api-key`), in registry order; CLIs with an unknown login, a doctor `warning` or a failing detection are left out; none qualifies → rejects with `NO_AGENT_CLI_MESSAGE` (doctor and terms doc) |
| Desktop provider order | `desktop/src/renderer/providers.test.ts` | The desktop agent menu and model lists follow the core registry order (`claude`, `codex`, `gemini`, `opencode`), read from `@concilium/core/providers`; every provider has its own color |
| Config precedence and runtime council | `packages/core/src/services/config-service.test.ts` | Per setting: explicit override (CLI flag or `deliberate()` option) > env var > saved config > built-in default (no key, jurors and chairman empty); saving one setting keeps the others; run overrides pick the OpenRouter jurors and chairman asked and an override API key is the one sent; `COUNCIL_MODELS` is trimmed and split on commas; settings fall through independently; reset returns to defaults. Through `createConciliumRuntime` with every driver faked: nothing configured and no key → the installed CLIs judge and `gemini` chairs, no request reaches OpenRouter; saved OpenRouter jurors without a key are replaced by the installed CLIs with a note |
| Ranking parser | `packages/core/src/domain/deliberation/ranking.test.ts` | `FINAL RANKING:` numbered list is read and earlier mentions are ignored |
| Prompts | `packages/core/src/domain/deliberation/prompts.test.ts` | Ranking prompt: each response under its `Response X` label, the task text, no model names, no example label order, label→model map, format the parser reads. Synthesis prompt: task, labelled plans, numbered juror evaluations, no agent or juror names. Research wrapper: read-only rules, user request last |
| Run storage | `packages/core/src/adapters/json-run-repository.test.ts` | Save/load round trip at `<dataDir>/runs/<id>.json`, missing id rejects, empty dir lists nothing, newest first regardless of file names, summary status and 70-char preview, `loadAll` strips raw output and keeps one final usage event, corrupt and non-JSON files are skipped |
| Desktop analytics formatting | `desktop/src/renderer/utils/analytics.test.ts` | Cost, token and duration display strings; subscription agents shown as subscription and left out of cost comparisons |
| Repo rules from `AGENTS.md` | `scripts/repo-invariants.test.mjs` (`npm run test:repo`, part of `npm test`) | License header ratchet (`MISSING_HEADER_BASELINE`, may only go down); core imports only its own files, builtins and declared deps; no `console` in core outside `shared/logger.ts`, nor in the CLI outside `commands/`/`formatters/`; the docs show only commands, subcommands and flags that `--help` lists, mention every command, and the CLI README has a table row for every flag |

### Headless CLI drivers (M1.1 to M1.5)

| Feature | Test | What it pins |
|---|---|---|
| Brief schema (M1.1) | `packages/core/src/domain/driver/brief.test.ts` | A brief survives JSON; a missing task and every bad field are named at once; a plan brief that allows `write` is refused; a non-object is refused |
| Report schema (M1.1) | `packages/core/src/domain/driver/report.test.ts` | `buildReport` counts events, adds usage, joins text (or keeps an explicit final text), reports no usage when none was sent; `parseReport` accepts a JSON round trip and names every bad field |
| Subprocess helper (M1.1) | `packages/core/src/adapters/cli/subprocess.test.ts` | A fake binary: stdout lines with parsed JSON, stderr lines, rate-limit flags, then one exit; the process group is killed on timeout, on abort and when the caller stops reading; a missing binary is a spawn error; a custom rate-limit detector |
| `FakeCliDriver` (M1.1) | `packages/core/src/adapters/cli/fake-cli-driver.test.ts` | Streams its script then one `done` with the report; stops and reports `aborted` on abort; refuses an invalid brief before streaming |
| Detection, auth status and model listing (M1.1) | `packages/core/src/adapters/cli/cli-drivers.test.ts` | Version parsing per CLI style; `claude auth status` JSON, `codex login status` on either stream, `opencode auth list` (a Claude subscription inside OpenCode comes back as a structured `warning`), Gemini API key variables checked for presence only; fake CLIs on `PATH` report version and auth, absent CLIs not-installed; `opencode models` lines become model ids (ANSI and non-ids dropped), other CLIs list none, a failing `opencode models` rejects |
| Claude Code driver (M1.2) | `packages/core/src/adapters/cli/claude-code.test.ts` (fixtures `cli/__fixtures__/claude-code-*.jsonl`) | Plan briefs run in plan mode with only the read tools; code briefs pre-approve only the allowed actions' tools. Fake `claude`: text, tool and usage events and an ok report holding the result text once; non-zero exit and error results are errors with the stderr tail; usage limits are `rate_limited` with one event and a retry delay (also from the result line alone); malformed lines skipped; timeout; missing binary |
| Codex driver (M1.3) | `packages/core/src/adapters/cli/codex.test.ts` (fixtures `cli/__fixtures__/codex-exec-*.jsonl`) | Plan briefs in the read-only sandbox without approvals; code briefs in workspace-write, network only when allowed. Fake `codex`: tool, text and usage events, ok report with the last message; file edits, MCP calls and web searches named as tools; non-zero exit; a failed turn is one error and drops the partial answer; usage limits (also stderr only) are `rate_limited`; malformed lines skipped; exit 0 without a finished turn is an error; timeout; missing binary |
| Gemini CLI driver (M1.4) | `packages/core/src/adapters/cli/gemini.test.ts` (fixtures `cli/__fixtures__/gemini-stream-json-*.jsonl`, documented format, not recorded) | Plan briefs in `default` approval mode, code briefs in `auto_edit`, never `yolo`. Fake `gemini`: tool, text and usage events, ok report with the joined answer; non-zero exit; a failed result drops the partial answer; `RESOURCE_EXHAUSTED` and a stderr-only 429 on a failed run are `rate_limited`, a retried 429 followed by success stays ok; malformed lines skipped; exit 0 without a result is an error; falls back to `--output-format=json` when stream-json is rejected, and reads a quota error from it; timeout; missing binary |
| OpenCode driver (M1.5) | `packages/core/src/adapters/cli/opencode.test.ts` (fixtures `cli/__fixtures__/opencode-run-*.jsonl`, follow the opencode 1.18.21 emitter, not recorded) | Plan briefs use the `plan` agent, code briefs `build`, never `--auto`; `OPENCODE_PERMISSION` keeps plan briefs read-only (no edits, no bash even when shell is allowed) and denies only the tools of actions a code brief does not allow. Fake `opencode`: tool, usage and text events, ok report; non-zero exit; a session error drops the partial answer; provider 429 and stderr-only rate limits are `rate_limited`; malformed lines skipped; exit 0 without a finished step is an error; timeout; missing binary |

### Code candidates (M2.1, M2.2, M3.1, M3.2)

| Feature | Test | What it pins |
|---|---|---|
| Worktree manager (M2.1) | `packages/core/src/adapters/git-worktree-workspace.test.ts` (real temp repos) | One worktree per candidate on `concilium/<run>/<candidate>` from `HEAD`, outside the repo; repeated `create` and `startRun` return the same worktree and base; a worktree dir deleted by hand and a stray dir git does not know are recovered; `remove` is idempotent and keeps the branch; a dirty tree is refused without `includeDirty`, and with it snapshotted to `refs/concilium/<run>/snapshot` so every candidate starts from the same bytes; unsafe run and candidate ids rejected; `commit` commits as `concilium` without ignored files, `diffStat` counts commits, files and lines against the base, an untouched candidate is no change |
| `gc` (M2.1) | same file, `GitWorktreeWorkspace gc` | Finished runs removed, active runs left alone; branches outside `concilium/` never touched, even look-alikes; the integration branch kept unless `includeIntegration`; the snapshot ref deleted; a dry run changes nothing and reports what a real run removes; a crashed run whose dir and manifest disagree, and a run whose repo was deleted, are collected, idempotently |
| `concilium gc` (M2.1) | `packages/cli/src/commands/gc.test.ts` | A killed run (its owner process gone) is collected by repeated `gc` runs while the user's checkout stays clean; an unknown run id says nothing is recorded; an invalid run id exits 1 |
| Parallel candidates (M2.2) | `packages/core/src/services/code-service.test.ts` (`FakeCliDriver`s that write files in their cwd, real temp repos) | Each agent runs a write-mode brief (`mode: 'code'`, `read`/`write`/`shell`) in its own worktree, never the checkout; its changes are committed on its branch, even after a failure; a failed or missing driver never stops the others; a candidate with no changes is `committed: false`; a second agent of the same CLI is `claude-2`; a dirty checkout is refused unless `includeDirty`; the checkout, index and branch are untouched; the run is finished so `gc` collects it; the record saves under `runs/<id>/run.json` (`JsonCodeRunStore`) |
| Playbooks and task-type classifier (M3.1) | `packages/core/src/domain/code-council/playbooks.test.ts` | `bugfix`, `feature`, `refactor`, `perf`, `prototype` each have ordered steps, verification expectations and a valid 3 to 6 criterion default rubric; a bugfix starts by reproducing with a failing test; `classifyTask` picks a type from whole-word keywords in priority order (prototype, perf, bugfix, refactor) with the matched word as the reason, and defaults to `feature` saying so |
| Rubric validation and freezing (M3.2) | `packages/core/src/domain/code-council/rubric.test.ts` | 3 to 6 criteria accepted, 2 and 7 rejected; every bad field (duplicate name, empty description, non-positive weight, evidence not `gate`/`adversarial`/`judgment`) named at once; unknown fields dropped; `freezeRubric` stamps `frozenAt` and a sha256 that changes with any criterion; the tailoring prompt holds the task, the type and its defaults and asks for JSON only; `parseRubricAnswer` reads a bare object, a fenced block or an array and rejects no JSON, broken JSON or a bad rubric |
| Framed briefs (M3.1, M3.2) | `packages/core/src/services/code-service.test.ts` (snapshots in `services/__snapshots__/`) | For each type, `codeBrief` holds the playbook steps and verification verbatim, and none of the rubric (no criterion, no sha256, no "rubric") |
| Rubric frozen before fan-out (M3.2) | same file | The first agent's CLI (with its model) gets one read-only framing run before any candidate starts; a valid answer is frozen as `source: 'framer'` and its hash is announced (`onFramed`) before the first candidate starts; no candidate brief carries its criteria or hash; a failed framer or a rubric with 2 criteria falls back to the playbook defaults with a `note`; without `type` the classifier's choice and reason are recorded in `taskType` |
| `concilium code` (M2.2, M3) | `packages/cli/src/commands/code.test.ts` (fake `claude`/`codex` scripts on `PATH`) | Each candidate on its own branch and worktree under `$XDG_CACHE_HOME/concilium/worktrees`, a failed one kept with its partial work, the checkout untouched, the saved record equals the `--json` output, `gc --dry-run` sees the run; the summary prints the type (`from --type` or the classifier's reason) and the rubric source and hash before the first candidate starts and in the summary, plus inspect and clean-up commands; the fake `claude` tailors the rubric in plan mode; candidate briefs hold the playbook but not the rubric's hash; a dirty checkout and an unknown `--type` exit 1 with a JSON error and empty stdout; exit 1 when every candidate fails, with the playbook rubric when the framer failed too |

### Known bugs, recorded as skipped tests

Each is an `it.skip` with a `BUG:` comment. Fix the code, then remove `.skip`; the test is already written.

None at the moment.

Not covered by any test yet: real CLI runs (every driver test uses a fake binary, and the Gemini and OpenCode fixtures are not recorded from a real run), real framer answers (the tailored rubric is only tested with fake CLIs), `OpenRouterGateway` HTTP error handling, cancelling a run from the desktop or the Ink UI, the rest of the Ink UI, the `history`/`config`/`models` command output, the Electron main process, and the desktop screens (including the `estimated API-equivalent` cost labels in `AgentPane`, `ResultsScreen` and `AnalyticsScreen`, and the `auto jurors` / `auto chairman` summary on `HomeScreen`; check those by eye with `npm run start -w concilium`).

## How the offline harnesses work

- **Deliberation e2e** (`deliberation-service.test.ts`) builds a real `DeliberationService` with a real `CliCouncilGateway` and swaps only the agent CLIs: every driver is a `FakeCliDriver` whose `respond(brief)` answers by role. A Stage 1 brief gets a fixed plan or an error. A council brief (its task names `council-prompt.md`) reads that file from `brief.cwd`: a ranking prompt (it ends with "provide your code review and ranking") gets a ranking that puts the preferred plan first; anything else is the chairman and gets a fixed synthesis. Don't key on `FINAL RANKING:`, since the synthesis prompt quotes the juror rankings. Config, secrets and run history use the real `JsonConfigStore`, `PlaintextSecretStore` and `JsonRunRepository` in a `mkdtemp` directory. `OPENROUTER_API_KEY`, `COUNCIL_MODELS`, `CHAIRMAN_MODEL` and `OPENROUTER_API_URL` are stubbed empty so the temp config is the only source, and no key is set. To test a new pipeline behavior, add a case there and assert on the returned `RunRecord`, the recorded events, the briefs in `driver.runs`, or what `JsonRunRepository` reads back.
- **Through the composition root** (`config-service.test.ts`, `create-concilium.test.ts`): `createConciliumRuntime` with real JSON stores in a temp dir, and every entry of `runtime.drivers` replaced by a `FakeCliDriver`, including the CLIs the test does not run (set `detection: { installed: false }`), because the runtime calls `detect()` on every driver when it fills in a default council or default agents. `fetch` is stubbed with `vi.stubGlobal` to act as OpenRouter (SSE for streaming juror calls, JSON for the chairman) and records every request. Use this when the behavior depends on runtime wiring, the default council, the default agents or the real `OpenRouterGateway`.
- **Code runs on real temp repos** (`git-worktree-workspace.test.ts`, `code-service.test.ts`, `gc.test.ts`, `code.test.ts`): each test `git init`s a repo in a `mkdtemp` dir, with `GIT_CONFIG_GLOBAL` (or `HOME`) pointing at a sandbox git config and `GIT_CONFIG_NOSYSTEM=1`, and a worktree root in the sandbox. In `code-service.test.ts` a candidate is a `FakeCliDriver` whose `respond(brief)` writes files into `brief.cwd`. The framing run comes first and is a plan brief whose cwd holds `council-prompt.md`: answer it by `brief.mode === 'plan'` (a rubric as JSON, or an error), and pick code runs with `driver.runs.filter((r) => r.brief.mode === 'code')`. In `code.test.ts` the fake `claude` answers the framing run when `council-prompt.md` exists in its cwd, and otherwise logs its cwd and edits files. Assert on the record, the branches (`git show <branch>:<file>`), and that `git status --porcelain` and `HEAD` of the checkout are unchanged.
- **Fake agent CLIs on `PATH`** (`subprocess.test.ts`, `cli-drivers.test.ts`, the four driver tests, `concilium.test.ts`, `code.test.ts`): write a small Node script named after the binary into a `mkdtemp` dir and make it executable (`0o755`). Its first line must be `#!${process.execPath}`, so it runs on the same Node without looking anything up, and the `PATH` the driver or CLI gets must contain only that temp dir (`createHeadlessCliDrivers({ PATH: binDir })`, or `env: { ...sandboxEnv, PATH: binDir }` for the CLI; `code.test.ts` symlinks `git` into it). Never append the real `PATH`: a real `claude`/`codex`/`gemini`/`opencode` would then run when a fake is missing. The script answers `--version` and the auth status command (`auth status`, `login status`, `auth list`) for detection, and for a run prints the CLI's own JSON stream (replay a fixture from `cli/__fixtures__/` or build lines inline); env vars or argv control its exit code and stderr. To check flags, have it append its argv to a file in the sandbox.
- **CLI** (`concilium.test.ts`): spawn `bin/concilium.ts` through the `tsx` loader with `HOME` and `XDG_*` pointed at a temp dir and an env that holds no API keys. Set `PATH: ''` when the command could reach an agent binary, or `PATH: <fake bin dir>` for a run on fake CLIs.
- **Ink components** (`CostSummary.test.ts`): render the component with Ink's `renderToString` and assert on the text. Keep these as `.test.ts` with `React.createElement`; the CLI `tsconfig.json` excludes only `*.test.ts` from the build.

## When to add or update tests

- **Changed a CLI flag, command or description:** run `npx vitest run packages/cli -u`. Read the snapshot diff and confirm every line of it was intended, then commit the `.snap` file with the change. Update `packages/cli/README.md` (options table) and any doc that shows the command, or `npm run test:repo` fails.
- **Changed deliberation, ranking, prompts, the council or persistence:** add or extend a case in the offline e2e or a co-located unit test (`file.ts` → `file.test.ts`). Default-council rules go in `council-members.test.ts`; how the runtime applies them goes in `config-service.test.ts`.
- **Changed a playbook, the classifier or the rubric rules:** extend `playbooks.test.ts` or `rubric.test.ts`, then run `npx vitest run packages/core/src/services/code-service.test.ts -u` and read the brief snapshot diff: playbook steps reach candidates verbatim, so every changed line is a change in what agents are told.
- **Changed worktrees, commits or `gc`:** extend `git-worktree-workspace.test.ts` on a real temp repo, and `gc.test.ts` when the CLI output or exit code changes. Never point a test at the repo you are working in.
- **Changed driver output parsing:** add or extend a recorded fixture in `adapters/cli/__fixtures__/` and assert on the normalized events and the report.
- **Changed how an agent CLI cost is shown:** keep the `est. API-equivalent` label (`AGENT_COST_LABEL` in `packages/cli/src/ui/format.ts`, `AGENT_COST_LABEL`/`AGENT_COST_LABEL_SHORT` in `desktop/src/renderer/utils/analytics.ts`) next to it, and extend `CostSummary.test.ts` for CLI output.
- **Fixed a bug:** first write a test that fails on the bug, then fix it. If the bug has a skipped `BUG:` test, unskip it instead.
- **Found a bug you are not fixing:** keep the failing test as `it.skip` with a `BUG:` comment, add it to the known-bugs table above, and report it.
- **Added an agent CLI:** add it to `PROVIDERS` (with its `family` and `models`) and give it a definition in `DEFINITIONS` in `adapters/cli/cli-drivers.ts` and a color in `desktop/src/renderer/providers.ts` (the typecheck fails until you do both). Put the argument building and line parsing in pure functions and test them with recorded fixtures and a fake binary on `PATH`. Never call the real CLI in tests. Update the registry order in `create-concilium.test.ts` and `providers.test.ts`.
- **Added a gateway adapter:** keep it behind `LlmGateway` and route to it from `CliCouncilGateway` by member spec. Never call the real service in tests.
- **Added license headers to old files:** lower `MISSING_HEADER_BASELINE` in `scripts/repo-invariants.test.mjs` to the count it reports.

## Rules for tests

- Assert on public outputs: the `RunRecord` or `CodeRunRecord`, the events emitted, the briefs a driver received, the files and branches written, the CLI's stdout and stderr. Don't assert on private helpers or call counts unless the count is the contract.
- Check that a new test catches a defect: break the code it covers once, see the test fail, then restore the code.
- No network, no real binaries, no `~`, no API keys: use temp dirs, fake CLIs on a `PATH` that holds only their temp dir, and pass `HOME`/`XDG_*` overrides to any spawned CLI (see `concilium.test.ts`).
- Silence the logger in tests that exercise noisy code: `beforeAll(() => setLogLevel('error'))`.
- New `.ts`/`.tsx` files need the MIT license header (see `AGENTS.md`); the repo invariants enforce it.
