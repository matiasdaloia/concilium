---
name: verify-concilium
description: Verify a change to the Concilium repo (core, CLI, desktop) offline. Use before committing or declaring a Concilium change done, when deciding which test covers a feature, or when adding a test for new behavior.
---

# Verify Concilium

Every check here runs offline. No API keys, no network, no real `claude`/`codex`/`opencode` binaries, and nothing reads or writes your home config.

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
```

The CLI tests, the desktop tests and the repo invariants import `@concilium/core` (and `@concilium/core/providers`) from `packages/core/dist`. After changing core, run `npm run build:core` before them.

## Feature map

| Feature | Test | What it pins |
|---|---|---|
| CLI command surface | `packages/cli/bin/concilium.test.ts` | `--help` and `run --help` text (snapshots in `bin/__snapshots__/`), every command is registered, `--version` matches `package.json`, `models --agent` offers every registered provider |
| Clean `--json` stdout | same file | `run --json` with no runnable agent (empty `PATH`) exits 1, prints `{"error": ...}` on stderr and nothing on stdout. Log lines go to stderr. |
| CLI cost labels | `packages/cli/src/ui/components/CostSummary.test.ts` | Ink output (`renderToString`): an agent CLI cost (Claude Code `total_cost_usd`, OpenCode `cost`) is labelled `est. API-equivalent` in the live agent line and in the cost summary (Agents header, Total row); no label when no agent reported a cost |
| Full deliberation (Stage 1 → 2 → 3) | `packages/core/src/services/deliberation-service.test.ts` | Agent plans become Stage 1, anonymized juror rankings aggregate to the right leaderboard, chairman output becomes Stage 3, stage events fire 1→2→3, the run record is persisted and listed in history |
| Degraded runs | same file | One surviving agent: ranking skipped, its plan is the answer. No OpenRouter key: Stage 2/3 skipped with a note. All agents fail: error event, rejected promise, nothing persisted |
| Agents with the same provider and model | same file | Two default OpenCode agents get distinct names (`opencode`, `opencode #2`) and two leaderboard rows |
| Subscription agent cost | same file | CLI agents get `costPer1kTokens: null` in model snapshots, never API per-token prices |
| Provider registry and composition root | `packages/core/src/services/create-concilium.test.ts` | `createProviders` builds one provider per `PROVIDERS` entry in registry order, ignores unknown ids; saved agent instances accept every registered provider and drop unknown ones |
| Desktop provider order | `desktop/src/renderer/providers.test.ts` | The desktop agent menu and model lists follow the core registry order (`claude`, `codex`, `opencode`), read from `@concilium/core/providers`; every provider has its own color |
| Config precedence | `packages/core/src/services/config-service.test.ts` | Per setting: explicit override (CLI flag or `deliberate()` option) > env var > saved config > built-in default; saving one setting keeps the others; run overrides pick the jurors and chairman asked and an override API key is the one sent (API key, API URL, jurors, chairman); `COUNCIL_MODELS` is trimmed and split on commas; settings fall through independently; reset returns to defaults |
| Ranking parser | `packages/core/src/domain/deliberation/ranking.test.ts` | `FINAL RANKING:` numbered list is read and earlier mentions are ignored |
| Prompts | `packages/core/src/domain/deliberation/prompts.test.ts` | Ranking prompt: each response under its `Response X` label, the task text, no model names, no example label order, label→model map, format the parser reads. Synthesis prompt: task, labelled plans, numbered juror evaluations, no agent or juror names. Research wrapper: read-only rules, user request last |
| Claude stream-json parsing | `packages/core/src/adapters/parsers/claude-parser.test.ts` (fixture `parsers/__fixtures__/claude-plan.jsonl`) | Recorded session → ordered thinking/tool/status/text events, tool labels with path or command, per-turn and cumulative final usage (cache tokens and cost included), `Run failed` status; blank lines, ANSI text and truncated JSON become raw events or nothing |
| Claude provider process handling | `packages/core/src/adapters/claude-provider.test.ts` | A fake `claude` script on `PATH` replays the fixture: success status and every event streamed; the plan is the final `result` text exactly once, not the streamed text deltas plus the result; non-zero exit is an error with raw error lines kept; a missing binary is an error |
| OpenCode working directory | `packages/core/src/adapters/opencode-provider.test.ts` | Every session request carries the agent's `cwd` as `directory` (fake `OpencodeClient`) |
| Run storage | `packages/core/src/adapters/json-run-repository.test.ts` | Save/load round trip at `<dataDir>/runs/<id>.json`, missing id rejects, empty dir lists nothing, newest first regardless of file names, summary status and 70-char preview, `loadAll` strips raw output and keeps one final usage event, corrupt and non-JSON files are skipped |
| Desktop analytics formatting | `desktop/src/renderer/utils/analytics.test.ts` | Cost, token and duration display strings; subscription agents shown as subscription and left out of cost comparisons |
| Repo rules from `AGENTS.md` | `scripts/repo-invariants.test.mjs` (`npm run test:repo`, part of `npm test`) | License header ratchet (`MISSING_HEADER_BASELINE`, may only go down); core imports only its own files, builtins and declared deps; no `console` in core outside `shared/logger.ts`, nor in the CLI outside `commands/`/`formatters/`; the docs show only commands, subcommands and flags that `--help` lists, mention every command, and the CLI README has a table row for every flag |

### Known bugs, recorded as skipped tests

Each is an `it.skip` with a `BUG:` comment. Fix the code, then remove `.skip`; the test is already written.

None at the moment.

Not covered by any test yet: the Codex provider, the OpenCode event stream beyond the working directory, `OpenRouterGateway` HTTP error handling, the rest of the Ink UI, the `history`/`config`/`models` command output, the Electron main process, and the desktop screens (including the `estimated API-equivalent` cost labels in `AgentPane`, `ResultsScreen` and `AnalyticsScreen`; check those by eye with `npm run start -w concilium`).

## How the offline harnesses work

- **Deliberation e2e** (`deliberation-service.test.ts`) builds a real `DeliberationService` and swaps only the two ports that touch the outside world. `FakeAgentProvider` returns a fixed plan or an error. `FakeLlmGateway` jurors read the anonymized ranking prompt and rank the response containing a preferred plan first; the chairman returns a fixed synthesis. Config, secrets and run history use the real `JsonConfigStore`, `PlaintextSecretStore` and `JsonRunRepository` in a `mkdtemp` directory. `OPENROUTER_API_KEY`, `COUNCIL_MODELS`, `CHAIRMAN_MODEL` and `OPENROUTER_API_URL` are stubbed empty so the temp config is the only source. To test a new pipeline behavior, add a case there and assert on the returned `RunRecord`, the recorded events, or what `JsonRunRepository` reads back.
- **Through the composition root** (`config-service.test.ts`): `createConciliumRuntime` with real JSON stores in a temp dir, `runtime.providers` entries replaced by fakes, and `fetch` stubbed with `vi.stubGlobal` to act as OpenRouter (SSE for streaming juror calls, JSON for the chairman). Use this when the behavior depends on the real `OpenRouterGateway` or on runtime wiring.
- **Subprocess providers** (`claude-provider.test.ts`): write a small Node script named after the binary into a temp dir, make it executable, and prepend the dir to `PATH` with `vi.stubEnv`. The script replays a recorded fixture; env vars control its exit code and stderr.
- **SDK providers** (`opencode-provider.test.ts`): pass a fake SDK client that records requests and yields recorded events.
- **CLI** (`concilium.test.ts`): spawn `bin/concilium.ts` through the `tsx` loader with `HOME` and `XDG_*` pointed at a temp dir. Set `PATH: ''` when the command could reach an agent binary.
- **Ink components** (`CostSummary.test.ts`): render the component with Ink's `renderToString` and assert on the text. Keep these as `.test.ts` with `React.createElement`; the CLI `tsconfig.json` excludes only `*.test.ts` from the build.

## When to add or update tests

- **Changed a CLI flag, command or description:** run `npx vitest run packages/cli -u`. Read the snapshot diff and confirm every line of it was intended, then commit the `.snap` file with the change. Update `packages/cli/README.md` (options table) and any doc that shows the command, or `npm run test:repo` fails.
- **Changed deliberation, ranking, prompts or persistence:** add or extend a case in the offline e2e or a co-located unit test (`file.ts` → `file.test.ts`).
- **Changed provider output parsing:** add or extend a recorded fixture in `__fixtures__/` and assert on the parsed events.
- **Changed how an agent CLI cost is shown:** keep the `est. API-equivalent` label (`AGENT_COST_LABEL` in `packages/cli/src/ui/format.ts`, `AGENT_COST_LABEL`/`AGENT_COST_LABEL_SHORT` in `desktop/src/renderer/utils/analytics.ts`) next to it, and extend `CostSummary.test.ts` for CLI output.
- **Fixed a bug:** first write a test that fails on the bug, then fix it. If the bug has a skipped `BUG:` test, unskip it instead.
- **Found a bug you are not fixing:** keep the failing test as `it.skip` with a `BUG:` comment, add it to the known-bugs table above, and report it.
- **Added a provider or gateway adapter:** keep it behind its port and register it in `PROVIDERS` plus `PROVIDER_FACTORIES`, and give it a color in `desktop/src/renderer/providers.ts` (the typecheck fails until you do). Put the parsing logic in a pure function and test it with recorded fixtures. Never call the real service in tests.
- **Added license headers to old files:** lower `MISSING_HEADER_BASELINE` in `scripts/repo-invariants.test.mjs` to the count it reports.

## Rules for tests

- Assert on public outputs: the `RunRecord`, the events emitted, the files written, the CLI's stdout and stderr. Don't assert on private helpers or call counts unless the count is the contract.
- Check that a new test catches a defect: break the code it covers once, see the test fail, then restore the code.
- No network, no real binaries, no `~`: use temp dirs and pass `HOME`/`XDG_*` overrides to any spawned CLI (see `concilium.test.ts`).
- Silence the logger in tests that exercise noisy code: `beforeAll(() => setLogLevel('error'))`.
- New `.ts`/`.tsx` files need the MIT license header (see `AGENTS.md`); the repo invariants enforce it.
