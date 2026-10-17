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
│       │   ├── commands/ # run, code, history, config, models, doctor, roles, gc
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

The desktop runs Electron 44 with `contextIsolation` and `sandbox` on and `nodeIntegration` off (`desktop/src/main/main.ts`); the renderer reaches the main process only through the preload's `window.electronAPI`. `--smoke-test` (`src/main/smoke-test.ts`) quits with 0 once the renderer has mounted with that API, 1 on a load failure, a renderer crash or 30 seconds; `npm run smoke -w concilium` runs the packaged app that way under `xvfb-run` in temp `HOME`/`XDG_*` dirs with an empty `PATH`, so no real agent CLI runs.

The desktop shows code-run directories a CLI run wrote, read-only (M9.2); it runs no code-council step itself. `readRunDir` (`src/main/run-dir.ts`) reads only `RUN_FILES` (`run.json`, `synthesis.md`, `dissent.json`, `decisions.tsv`, `verification.md`, `reframe.md`) by name, skipping, with a note, a file whose real path is outside the directory, that is not a file or that is over `MAX_RUN_FILE_BYTES`; the pure `parseRunDir` (`src/main/run-view.ts`) turns them into a `RunView` (`src/shared/run-view.ts`, type-only core imports so the renderer can use it): candidates, ranking, survival matrix, dissent (`dissent.json`, else the record's), decision trail (`parseDecisions`), synthesis, verdict (`prVerdict`) and the reports. A missing `run.json`, one that is not JSON or not `kind: 'code'`, a `version` other than `KNOWN_RECORD_VERSION`, or an unreadable section becomes a `notes` line, never an error. `rankCells` gives the ranking table's cells and `rankingLine` writes them as the `synthesis.md` `## Ranking` table line. IPC: `runs:open` (an open dialog that starts in `cliRunsDir()`) and `runs:initial` (`--open-run <dir>`, `openRunArg`) take no argument from the renderer. `RunViewerScreen` renders it (`data-run-view`, `data-ranking-row`, `data-run-error`). With `--smoke-test --open-run <dir>`, the smoke test waits for the viewer and prints each rendered ranking row as its `synthesis.md` table line, failing on an open error or no ranking; `npm run smoke -w concilium -- --open-run <dir>` forwards it. Tests: `run-view.test.ts`, `run-dir.test.ts` (the fixture `src/main/__fixtures__/code-run/`, written by `concilium code` and `verify-pr` on fake CLIs with `node desktop/scripts/make-run-fixture.mjs` after `npm run build`: the rendered rows equal its `synthesis.md` table; a symlink out of the directory is not read).

Agent providers (`claude`, `codex`, `gemini`, `opencode`) are listed once, in the `PROVIDERS` registry (`packages/core/src/domain/agent/providers.ts`), with their model family and model list, and a headless CLI driver per id in `adapters/cli/cli-drivers.ts`.

Every stage runs through the `HeadlessCliDriver` port (`packages/core/src/ports/headless-cli-driver.ts`), under the user's own CLI logins, with no API key: one driver per installed agent CLI (`adapters/cli/cli-drivers.ts`), a versioned `Brief` in and a versioned `Report` out (`domain/driver/`), processes spawned through `adapters/cli/subprocess.ts`, and `FakeCliDriver` for tests. Drivers only use the CLI's own login and never read credential files (see `docs/research/subscription-tos.md`). A run with `isolated` (`DriverRunOptions`; every `CliCouncilGateway` run sets it: jurors, chairman, framer, judge, graft picker, reframe, planner, verifier) skips the user's hooks, plugins, memory and MCP servers through the CLI's own flags only, keeping the login and never touching its config dir: `CLAUDE_ISOLATED_ARGS` (`--safe-mode`; `--bare` would drop the subscription login), `CODEX_ISOLATED_ARGS` (`--ignore-user-config --disable=hooks --disable=plugins`; the user's `AGENTS.md` still loads), `OPENCODE_ISOLATED_ARGS` (`--pure`); Gemini has no checked flag and runs as usual. Candidates and Stage 1 agents are not isolated. `detect()` works for every CLI and is used by `concilium doctor`. `run()` works for Claude Code (`adapters/cli/claude-code.ts`: `claude -p --output-format=stream-json`, plan briefs in plan mode, only the tools of the brief's allowed actions) and Codex (`adapters/cli/codex.ts`: `codex exec --json`, plan briefs in the read-only sandbox, code briefs in workspace-write, network only when allowed, no approvals) and Gemini CLI (`adapters/cli/gemini.ts`: `gemini --output-format=stream-json --prompt=...`, falling back to `json` on versions without stream-json; plan briefs in the `default` approval mode, which headless leaves with only read-only tools, code briefs in `auto_edit`, never `yolo`; its fixtures follow the documented format but are not recorded) and OpenCode (`adapters/cli/opencode.ts`: `opencode run --format=json`, plan briefs with the `plan` agent, code briefs with `build`, never `--auto`; `OPENCODE_PERMISSION` denies the tools of actions the brief does not allow, and bash for plan briefs, since the `plan` agent allows it; its fixtures follow the emitter in the installed opencode 1.18.21 but are not recorded; never use it with a Claude subscription login).

The plan council uses the drivers in all three stages. Stage 1 agents (`domain/agent/agent-executor.ts`) get a read-only plan brief (read and network actions) in the run's `cwd`. Without `--agents` (CLI), `agents` (`deliberate()`) or saved agents (desktop), `runtime.defaultAgentInstances()` picks one agent per CLI whose `detect()` says installed and signed in (`subscription` or `api-key`) with no `warning`, in registry order, and rejects with `NO_AGENT_CLI_MESSAGE` (pointing to `concilium doctor` and `docs/research/subscription-tos.md`) when none qualifies. Every family check (judge, adversaries, verifier, role rules, ledger, chairman seat) goes through `agentFamily(provider, model)` (`providers.ts`; `familyKey` falls back to the provider id): a CLI with a family keeps it, and OpenCode's comes from its model id, `<vendor>/<model>` or `<provider>/<vendor>/<model>` for a vendor in `VENDOR_FAMILY` (`anthropic`, `openai`, `google`), else unknown (`opencode:openrouter/google/gemini-3-pro-preview` is `google`, `opencode:mistral/devstral-2` unknown). Jurors and the chairman are council member specs (`domain/council/council-members.ts`): `cli[:model]` (`claude`, `codex:gpt-5.2`, `opencode:openai/gpt-5.2`) runs that CLI through `CliCouncilGateway` (`adapters/cli/cli-council-gateway.ts`) on a read-only plan brief in a fresh temp dir holding only the prompt file; any other id is an OpenRouter model, sent to `OpenRouterGateway` only when an API key is configured (otherwise it is skipped with a note). `resolveCouncil` fills missing jurors with every installed, signed-in CLI with a known family (OpenCode only as a last resort) and a missing chairman with the usable CLI whose family holds the fewest juror seats; `createConciliumRuntime` runs `detect()` only when it has to fill one in. Tests swap drivers for `FakeCliDriver`s (`runtime.drivers.set(...)`, or `respond(brief)` for fakes that read their prompt).

Candidate worktrees (M2.1) go through the `WorkspaceManager` port (`packages/core/src/ports/workspace.ts`) and its adapter `GitWorktreeWorkspace` (`adapters/git-worktree-workspace.ts`). `startRun` pins `baseSha = HEAD` and refuses a dirty tree unless `includeDirty`, which commits the working tree through a temp index to the scratch ref `refs/concilium/<run-id>/snapshot` and leaves the user's index and checkout alone. `create` adds a worktree at `<root>/<repo-hash>/<run-id>/<candidate-id>` on branch `concilium/<run-id>/<candidate-id>` (`integrationBranch(runId)` is `concilium/<run-id>/integration`). The root is a constructor option; the CLI passes `$XDG_CACHE_HOME/concilium/worktrees` (`getWorktreeRoot()`), never a dir inside the target repo. A run manifest (`<run-id>/manifest.json`) is written before any worktree and records the base, the candidates and the owner process. Every operation is idempotent and repairs what a crash leaves (deleted dirs, stale manifest entries, half-added worktrees) from the manifest, `git worktree list --porcelain` and `git worktree prune`. `gc` collects runs that are finished or whose owner process is gone, deletes only `refs/heads/concilium/<run-id>/*` and `refs/concilium/<run-id>/*`, and keeps the integration branch unless `includeIntegration`. `commit` commits what a candidate left in its worktree on its branch as `concilium` (`--no-verify`, ignored files left out), and `diffStat` counts the branch's commits, files and lines against the base. Tests run on real temp repos (`git-worktree-workspace.test.ts`, `packages/cli/src/commands/gc.test.ts`).

`concilium code` (M2.2) is `runCodeCandidates` (`packages/core/src/services/code-service.ts`): it pins the base with `startRun`, creates one worktree per agent (candidate id = provider, `claude-2` for a second one), runs every driver in parallel on a `codeBrief` (`mode: 'code'`, `read`/`write`/`shell`, `cwd` = the worktree; each driver keeps what its CLI can do safely), then `commit`s and `diffStat`s each candidate, even a failed one, and calls `finishRun` so `gc` can collect it. A candidate that fails (driver error, missing driver, worktree error) is recorded with `status: 'error'` and never stops the others. The worktrees stay for inspection. Before the worktrees (M3.1, M3.2), the run is framed in `domain/code-council/`: the task type is `--type` (`type` input) or `classifyTask`'s keyword guess (default `feature`), recorded with its reason as `taskType`; `PLAYBOOKS` (`playbooks.ts`) holds per type the ordered steps, the verification expectations and 3 to 6 default rubric criteria (`name`, `description`, `weight`, `evidence`: `gate`/`adversarial`/`judgment`). The first agent's CLI gets one read-only `CliCouncilGateway` run on `rubricPrompt` to tailor the criteria; a failed run or an answer `parseRubricAnswer` rejects falls back to the playbook defaults with a `note`. `freezeRubric` validates 3 to 6 criteria and stamps `frozenAt` and a sha256 (`rubricHash`) into the record's `rubric`, and `framedTask` puts the playbook into every candidate brief. Candidates never see the rubric: `framedTask` and `codeBrief` take only the task type, and the rubric goes only to the record, `onFramed` and the CLI output. Tests: `playbooks.test.ts`, `rubric.test.ts`, `code-service.test.ts` (per-type brief snapshots). The CLI saves the `CodeRunRecord` with `JsonCodeRunStore` to `<dataDir>/runs/<run-id>/run.json`, a directory the plan-run listing ignores. After the candidates (M4.1), unless `--no-verify` (`verify: true` input; core defaults to off), `verifyCandidates` (`services/verification-service.ts`) creates the scratch lane `base` with `create` (branch `concilium/<run-id>/base`, collected by `gc`), decides the gates from it with `GateRunner.plan` (`adapters/gate-runner.ts`; `planGates` in `domain/verification/gates.ts`: `.concilium/verify.yaml` `gates`/`install` replace detection; detection is `package.json` scripts `typecheck`/`lint`/`test`, the same Makefile targets, `go vet`/`go test`, `pytest`, `cargo test`; `npm ci` when `package-lock.json` exists and `node_modules` does not), runs them once on the base and then on each candidate head, one lane at a time (`/bin/sh -c`, scrubbed env via `gateEnv`, 10-minute `GATE_TIMEOUT_MS`, the last `OUTPUT_LIMIT` characters kept, each result carrying the SHA it ran at), and `judgeGates` keeps only new failures against the base (`baseline-failure` otherwise). Tier 0 is `checkIntegrity` (`domain/verification/integrity.ts`) on `git diff -M base head`: deleted or moved test files, new skip/only markers and lowered coverage thresholds `disqualify`; gate config edits (lint, tsconfig, test runner, CI, `.concilium/`, gate scripts in `package.json`) and added dependencies are `penalty`, each with its hunk as `evidence`. The result is `verification` on the record (plan, baseline) and on each candidate (`PASS`/`ISSUES`, `disqualified`, `newFailures`, `penalties`). Then (M4.2), unless `--no-adversarial` (`adversarial: true` input; core defaults to off; skipped with a reason without the gates, with fewer than 2 candidates with a head, or with no test gate), `runAdversarialRound` (`services/adversarial-service.ts`) runs Tier 2: one adversary per candidate model family (`familyKey(provider, model)`: the provider id for OpenCode on an unknown vendor), the first candidate of that family's CLI and model, on an `adversaryBrief` (`domain/verification/adversarial.ts`; `mode: 'code'`) in its own worktree `adv-<family>` from the base, with the other families' `git diff base head` as read-only patch files in a temp dir (listed in the brief's constraints, removed after), in parallel, with the candidate timeout. It lists its tests in `concilium-adversarial.json` (`{"tests": [{"files": [...], "specClause": "..."}]}`); `parseAdversarialManifest` keeps existing relative test files with a clause, at most `MAX_TESTS_PER_ADVERSARY` (5), and its branch is committed. Each test (`<family>-<n>`) runs under the plan's test gate (`testGate`) through `GateRunner.runStep` on the `base` lane and every candidate worktree, one at a time: its files are copied in and restored after, so no branch changes; a lane whose own test gate did not pass is not run and gets `error`. `classifyTest` applies the validity rule (`evidence` only when it fails on the base and passes on a candidate of another family than its author, `own-family-only` when it passes only on its author's family, `quarantined`, `vacuous` for a bugfix, `regression-guard` otherwise, `unrunnable`), and `survival` counts per candidate the `evidence` and `regression-guard` tests of other families. The result is `adversarial` on the record (`adversaries`, `tests`, `matrix`, `survival`, `runs`). Last (M4.3), `rankRun` (`services/ranking-service.ts`) gives each candidate a `report` (`reportCandidate`; `CandidateReport` in `domain/code-council/ranking.ts`: `PASS`/`ISSUES`/`BLOCKED`, `branch`, `baseSha`, `headSha`, `evidence` of kind `agent`/`gate`/`integrity`/`survival`/`playbook`, `reason`; `BLOCKED` = no head or no change; a final message that does not acknowledge every playbook step, per `missingPlaybookSteps` in `framing.ts`, is an `ISSUES` finding) and ranks them with the pure `rankCandidates`: `compareEvidence` puts blocked then disqualified last, then fewer new gate failures, higher survival rate (none counted = 1), fewer penalties. Unless `--no-judge` (`judge: true` input; core defaults to off), each exact tie group of candidates that can win (`tieGroups`, `contends`) goes to `judgeTie`: BLOCKED when `rubricHash(criteria)` no longer equals the frozen `sha256`; `pickJudge` (`domain/code-council/judging.ts`) takes the first installed, signed-in CLI in registry order whose family wrote none of the tied candidates, and only when there is none the first usable one, flagged `sameFamily: true` with `sameFamilyReason` on the `Judgment`, a `judge` evidence line (`ok: true`) in each tied report and a `Warning:` line in the CLI summary; one read-only `CliCouncilGateway` run on `judgePrompt` (blind letters, diffs capped at `JUDGE_DIFF_LIMIT`, evidence without the agent line, the frozen rubric, no example ordering); `parseJudgeAnswer` requires one 0 to 10 score with a reason per candidate and criterion, else BLOCKED. A PASS `Judgment`'s weighted totals order only its tie group. A tie still at the top after that (judge BLOCKED, `--no-judge`, equal totals) goes to the smallest diff (`size`: insertions plus deletions, then files changed, then candidate id), with a reason starting `tie broken by smallest diff`; the winner is null only when every candidate is blocked or disqualified. The result is `ranking` on the record (`order` with `rank`, `key`, `size`, `judgeTotal`; `winner` or null with `reason`; `judgments`). Then (M5.1), unless `--no-synthesis` (`synthesis: { runDir }` input, the CLI passes `JsonCodeRunStore.runDir(runId)`; core defaults to off; skipped with a reason for a `prototype`, with fewer than 2 candidates, without a winner or without the gates), `synthesize` (`services/synthesis-service.ts`) takes the winner as the base: `create` with `fromSha` = its head makes `concilium/<run-id>/integration` (kept by `gc`). Blocked and disqualified candidates are `dropouts`; for the others one read-only `CliCouncilGateway` run (the CLI `pickJudge` gives for the base's and the donors' families, `usableClis`) on `graftPrompt` (`domain/code-council/synthesis.ts`: the base and blind letters, diffs and evidence without the agent and judge lines) names grafts, which `parseGraftAnswer` keeps when their files are in that candidate's diff, at most `MAX_GRAFTS_PER_CANDIDATE` (2) each. Each graft gets a fresh run of the base's CLI and model on an `integratorBrief` (`mode: 'code'`, the source diff as a read-only temp patch file) in the integration worktree, and is `commit`ted alone; it is re-verified with `GateRunner.runLane` and, when the test gate passes, every `evidence`/`regression-guard` adversarial test through `runTestInLane`, plus `integrity` on the graft's own diff. A gate or valid test that passed before and does not after, a disqualifying finding, or a failed or empty integrator run rejects it: `revert` commits its revert and the failing runs are its `evidence`. Then `patch` (`git diff --binary` base..integration) goes to `<runDir>/result.patch`, `checkPatch` runs `git apply --check --cached` on a scratch index of the target's current `HEAD`, or of `synthesis.mergeTarget`'s commit when given (`mergeable`; `mergeCheck.target` names it), and `synthesisMarkdown` writes `<runDir>/synthesis.md` (its `## Ranking` table, `rankingMarkdown`, is `ranking.order` with each rank, then the winner). The result is `synthesis` on the record (`base`, `branch`, `headSha`, `picker`, `grafts`, `dropouts`, `checks`, `patchPath`, `synthesisPath`, `mergeable`, `mergeCheck`). Before synthesis (M5.2; only when `synthesis` is asked for and the type is not `prototype`), `detectDivergence` (`domain/code-council/reframe.ts`, pure) looks at the candidates that `contends` (at least 2): `no-gate-pass` when each has a new gate failure; else `disjoint-survival` when, among those passing the gates, each fails at least one `evidence`/`own-family-only`/`regression-guard` test of another family and no two fail the same test (its `tests` are the failed ones); and `judge-spread` when `PASS` judgments of the same tie pick different tops (one judge runs per tie today, so it cannot fire yet). When every divergence is `disjoint-survival` (complementary misses), `synthesize` runs first with those tests as `conflictTests`: they join the valid suite each graft is re-verified with, and are re-run (`check`) at the final integration head; `settleDivergence` (`synthesis.ts`) records `synthesis.divergence` (`tests`, `resolved`, `reason`): resolved when every gate passing on the base passes there and so does every conflicting test, and then the run is `done` with `result.patch`. Unresolved, no `result.patch` is written (the integration branch stays), `synthesis.md` says so, and `reframeRun` runs with `grafting` (`branch`, `headSha`, `applied`, `rejected`, `outcome`, `synthesisPath`), recorded on `reframe` and as a `## Grafting` section of `reframe.md`. On any other divergence, and after an unresolved one, `reframeRun` (`services/reframe-service.ts`) runs the first agent's CLI and model (the framer) once, read-only, on `reframePrompt` (the divergence, each line in conflict, the diffs); `parseReframeAnswer` keeps questions whose `clause` is a line in conflict, and `completeQuestions` gives every other line a `fallbackQuestion` from the evidence. `reframe.md` (`reframeMarkdown`) goes to the run dir, `synthesis` is `skippedSynthesis(...)` (no integration branch, no `result.patch`) unless grafting was tried first, the record gets `reframe` and `status: 'reframe-needed'` (`'done'` otherwise), and the CLI exits 2. Tests: `reframe.test.ts`, `code-service.test.ts` (`runCodeCandidates reframe`), `code.test.ts`. Last (M6.1), `recordDissent` (`services/dissent-service.ts`) runs `collectDissent` (`domain/code-council/dissent.ts`, pure) over the ranking, the adversarial tests and the synthesis: `base-pick` (a `PASS` judgment over the winner whose top total is another candidate; both `rationales`, `overruled` with the winner's evidence key and head), `adversarial-test` (a test in `synthesis.checks.tests` that is not `pass` at the integration head; `open`, its `specClause` as `acceptanceClause`), `quarantined-test` (`warning`, with its clause and `QUARANTINED_REASON`; a warning never blocks the mergeable label), `rejected-graft` (`overruled` by its gate/test/integrity evidence with SHAs and the revert, `open` when only the integrator failed), `rubric-spread` (judgments of the same tie scoring one candidate on one criterion more than `RUBRIC_SCORE_SPREAD` (3) apart; `open`) and `same-family-judge` (a flagged judgment or graft picker; `accepted-risk` with its reason). Each `Dissent` has `id` (`dissent-<n>`), `source`, `summary`, `evidence` (`commit`/`test`/`file`/`judgment`/`rubric` pointers), `acceptanceClause`, and `resolution` (`open` | `accepted-risk` | `overruled` | `resolved` | `warning`) with `resolutionReason` (null only when `open`; the type requires it otherwise). `withDissent` sets `synthesis.mergeable` to false with `mergeBlock` when `blockingDissent` (open, with an acceptance clause) is not empty; the patch is still written. When `synthesis.md` or `reframe.md` was written, `dissent.json` (`{version, runId, records}`) goes next to them and both are re-rendered with `dissentMarkdown` (`## Dissent`, open first) right after the task line. The record carries `dissent` (`path`, `records`) right after `status`; the CLI prints open dissent right after the run line, then each `warning` (`warningDissent`) as a `Warning:` line, and the block reason on the `Mergeable` line. Tests: `dissent.test.ts`, `code-service.test.ts` (`runCodeCandidates synthesis`, `reframe`), `code.test.ts`. With `trail: { runDir, commit? }` (M6.2; the CLI always passes the run dir, and `commit: false` for `--no-trail-commit`), the orchestrator, never an agent, keeps `DecisionTrail` (`services/trail-service.ts`): `events.jsonl` (`run-start` with the repo and base, every progress callback through `traced`, each `decision` event) and `decisions.tsv` (`DECISION_COLUMNS` in `domain/code-council/trail.ts`: `ts`, `event`, `step`, `decision`, `chosen`, `alternatives`, `evidence`, `reason`; built by `decisions.*`), both append-only through one write queue; `rubric.json` is the rubric row's evidence. Rows, in order: `task-type`, `rubric`, `candidates` (with the roles), `gate-plan`, one `verification` per candidate, `adversarial`, one `judge` per judgment, `ranking`, `base-pick`, one `graft` per graft, `divergence` (only with `synthesis`), `dissent`, `mergeable`. Evidence is `commit:<sha>` or `file:<path relative to the run dir>`. After the last row, unless `commit` is false, `trail.commit` copies `decisions.tsv`, `dissent.json` and `synthesis.md` to `.concilium/runs/<run-id>/` in the integration worktree and commits them as its last commit (also on an unresolved divergence's kept branch); `result.patch` was cut before, so it does not carry them, and `synthesis.headSha` stays the code head. `checkTrail(runDir)` resolves the pointers (`commitExists` in the repo of `run-start`) and runs the pure `auditTrail`: a row with no event, a non-`decision` event, fields that differ from its event, a second row for an event, a row out of event order, no evidence or unresolved evidence, and a decision event with no row are each a problem with its line. The record carries `trail` (`decisionsPath`, `eventsPath`, `rows`, `commitSha`, `errors`); the CLI prints the path and the commit at the end of the summary, and `concilium trail check --run <id>` (`commands/trail.ts`) exits 1 on a problem. The cross-family trail review (an "Attention" list in `synthesis.md`) is not built yet. Tests: `trail.test.ts`, `code-service.test.ts` (`runCodeCandidates synthesis`), `code.test.ts`. No rebase onto a moved target or sandbox yet. Tests: `synthesis.test.ts`, `git-worktree-workspace.test.ts`, `code-service.test.ts` (`runCodeCandidates synthesis`), `code.test.ts`. Tests: `ranking.test.ts`, `judging.test.ts`, `framing.test.ts`, `code-service.test.ts` (`runCodeCandidates ranking`), `code.test.ts`. Tests: `gates.test.ts`, `gate-runner.test.ts` (real temp repos), `code-service.test.ts`, `code.test.ts`. Tests: `code-service.test.ts` (`FakeCliDriver`s that write files in their cwd, real temp repos) and `packages/cli/src/commands/code.test.ts` (fake `claude`/`codex` scripts on `PATH`).

Per-role models (`domain/roles/roles.ts`, `services/role-service.ts`): the code council's roles are `planner` (frames the rubric and phrases reframe questions), `implementer` (the candidates; `agents` in `CodeRunInput`), `adversary` (at most one per family), `judge` (ties and the graft picker) and `integrator`; shipping's (`SHIP_ROLES`) is `verifier` (`concilium pr`/`verify-pr`; not in `CodeRoleMap`, not recorded on a run, refused by `code --role`); the plan council's are `juror` and `chairman`. Each member is `cli[:model]` (jurors and chairman may be OpenRouter ids). `validateRoles(raw, origin)` names every violation at once (unknown role, a list for a single role, a non-CLI member of a code role, an empty model, a keyword listed with members, two adversaries of one family) in a `RolesValidationError`; `parseFactoryRoles(text, path)` reads the `roles:` section of `.concilium/factory.yaml` (`FACTORY_CONFIG`; `parseFactoryConfig` also reads the top-level `allow-same-family-verifier`, true or false; other sections are not read yet); `parseRoleFlags` reads `--role role=members` (a list role splits on commas and adds up across flags, a single role twice is an error). `runtime.resolveCodeRoles({ repoDir, flags })` picks per role flag > repo (`readRepoRoles`: the nearest `factory.yaml` from `repoDir` up to the first dir with `.git`, read at every call) > saved (`CouncilConfigPrefs.roles`, `ConfigService.saveRoles`/`savedRoles`) > default (`resolveCodeRoles`: implementers from `defaultAgentInstances()`, detected only when no source names them; planner = first implementer; the keywords `same-as-implementer`, `auto`, `winner`), with the source of each in the `CodeRoleMap`. `runtime.resolveVerifier({ repoDir, flags, allowSameFamily? })` picks the verifier flag > repo > saved > `auto` (`resolveVerifierRole`) without detecting, and returns a `VerifierRole` whose `allowSameFamily` is the `ALLOW_SAME_FAMILY_VERIFIER` opt-in, flag (`--allow-same-family-verifier` on `pr`, `verify-pr`, `factory`) > repo (top-level `allow-same-family-verifier` in `factory.yaml`) > saved (`config set allow-same-family-verifier true|false`, `CouncilConfigPrefs.allowSameFamilyVerifier`) > false (`resolveAllowSameFamily`). `runtime.resolveRoleMap` adds `verifier`, `juror` and `chairman` (flag > env > repo > saved > default, from `ConfigService.resolveWithSources`), and a missing agent CLI is a note there; `resolveCouncilConfig`/`createDeliberationService` take `{ repoDir }` for the repo layer (`run` and `deliberate()` pass their cwd). `runCodeCandidates` takes `roles` (default `defaultCodeRoles(agents)`) and records it as `roles`: the planner runs `frameRubric` and `reframeRun`; a configured adversary list goes to `runAdversarialRound` as `adversaries`, each replacing its family's default (the first candidate of the family) or adding a lane for a family with no candidate; a configured judge is `judgeSpec` for `judgeTie` and `pickerSpec` for `synthesize`, through `configuredJudge`, which keeps it and flags `sameFamily` (reason `the configured judge <spec> is of one of the families it reads (...)`, or of an unknown family) instead of picking another CLI; a configured integrator replaces the base's CLI and model in `applyGraft`. The CLI prints the map (`formatters/roles.ts`) before the first candidate and in the summary; `concilium roles` prints the full map, `config set <role>` saves one. Tests: `roles.test.ts`, `role-service.test.ts`, `judging.test.ts` (`configuredJudge`), `code-service.test.ts` (configured judge and planner, adversaries, picker and integrator, default map), `code.test.ts` (`roles`), `concilium.test.ts` (factory.yaml jurors and chairman in `run`).

Role config validator (M8.3, C4; `domain/roles/role-rules.ts`, `checkRoleFamilies` and `parseCommandRoles` in `roles.ts`): every rule is a `RoleRuleId` in `ROLE_RULES` with its `severity` (`error`/`warning`) and default `hint`, and every problem is a `RoleViolation` (`rule`, `severity`, `role`, `source` `flag`/`repo`/`saved`/`default`, `at` the config path: `--role judge`, `--agents`, `<path>/.concilium/factory.yaml roles.judge`, `saved config roles.judge`, `config set judge`, or `.concilium/factory.yaml roles.<role>` for the rules checked after resolution; `message`, `hint`), made by `violation(rule, origin, role, message, hint?)` from a `RoleOrigin` (`roleOrigin.flag(option)`, `.file(source, file)`, `.resolved(source)`) and printed by `formatViolation` as `[<rule>] <at>: <message>. Fix: <hint>`. `RolesValidationError` carries `violations` (its message is one formatted line each). Per source: `factory-yaml`, `roles-not-a-mapping`, `unknown-role`, `list-for-single-role`, `no-members`, `keyword-with-members`, `unknown-cli`, `empty-model`, `adversary-family-twice`, `flag-syntax`, `flag-repeated`. `parseCommandRoles(command, { roles, agents })` adds `agents-and-implementer` and `role-not-applicable` (`ROLE_COMMANDS`: `code` the code roles, `factory` those and `verifier`, `pr`/`verify-pr` only `verifier`, `roles` all), collecting every violation of every flag. `checkRoleFamilies({ roles?, verifier?, authors? })` is C4 on resolved roles; `auto` never violates: a configured judge of an unknown family (OpenCode without a known vendor in its model id) is `unknown-family`, of a family with two or more implementers `judge-judges-itself` (they can tie alone, and be all the graft picker reads), errors; of a family with one implementer `judge-shares-family`, a warning; a configured verifier of an unknown family is `unknown-family`, and of an author family `verifier-author-family`, errors (with the verifier's `allowSameFamily` opt-in, `verifier-author-family-allowed`, a warning instead; `unknown-family` stays an error), where the authors are `authors` when given (`pr`/`verify-pr`: `shipSource(record).authorFamilies`) else every implementer family and a configured integrator's. `throwOnRoleErrors(violations)` throws the errors and returns the warnings. `code`, `factory`, `pr` and `verify-pr` parse their flags, resolve the roles and the verifier, and run `checkRoleFamilies` before any agent CLI runs (an invalid `factory.yaml` stops before detection; the family rules may need detection for default implementers): an error prints `Error: <line>` per violation (`--json`: `{ error, violations }`) and exits 1, a warning prints `Warning: <line>` and the command goes on (`printError`, `violationLines` in `formatters/roles.ts`). `concilium roles` prints the violations under the table (`violations` in `--json`) and exits 1 on an error. `pickVerifier` still passes over a configured verifier it cannot use (not installed or signed in) for API callers. Tests: `roles.test.ts` (one rejecting case per rule, checked against `ROLE_RULES`), `role-service.test.ts`, `code.test.ts` (`roles`: nothing spawned on an invalid `factory.yaml` or a family rule), `pr.test.ts` (an author-family verifier refused).

Autonomy tiers (M7.1, B10): `ActionGate` (`services/action-gate.ts`) is the one module that may build a `git push` or a `gh` command; every orchestrator side effect that could leave the run's own worktrees, `concilium/` branches and run store goes through `gate.request({ kind, command, cwd, ref?, reason? })`. `classifyAction` gives the tier: `proceed` (`worktree`, `branch` and `delete` of a `concilium/` or `refs/concilium/` ref, `run-cli`, `gate`, `store-write`, `revert`, `gc`) runs the argv without a shell; `proceed-and-announce` (`install`, `rebase`) also calls `onAnnounce`; `always-pause` (`push`, `pr`, `write-checkout`, `branch`/`delete` of any other ref, `deploy`, `message`) runs nothing and appends a `GateEntry` (`id` `<run-id>-g<n>`, `command`, `cwd`, `reason`, `requestedAt`, `status`) to `gates.json` and re-renders `gates.md` in the run dir, under a `gates.lock` file. A request with a `key` (stored on the entry) reuses a `pending`, `approved` or `executed` gate of its kind with the same key, command and cwd (`reused: true` on the outcome), and marks every other `pending` keyed gate of its kind `superseded` (returned as `superseded`), which can never be approved. `approveGate(runsDir, id)` runs only that pending gate (marked `approved` before the command starts, then `executed` or `failed` with `exitCode` and the last `GATE_OUTPUT_LIMIT` characters of output); `rejectGate` marks it `rejected`; a decided gate is never decided again, and no approval covers another gate. `gitPushCommand(remote, refspec)` builds a push for a `push` request and `ghPrCreateCommand({ head, title, bodyFile, base?, draft? })` a `gh pr create` for a `pr` request. The CLI has `concilium gates [--run <id>] [--json]`, `concilium approve <gate-id>` and `concilium reject <gate-id>` (`commands/gates.ts`). Every agent CLI run gets `withoutPushCredentials(env)` (`adapters/cli/agent-env.ts`, applied in `CliDriver.run`): `PUSH_CREDENTIAL_VARS` removed, `credential.helper` reset to empty through `GIT_CONFIG_COUNT`, `GIT_TERMINAL_PROMPT=0`; it does not stop an agent that passes its own `-c credential.helper`, reads `~/.git-credentials` or uses an ssh key on disk. Gates keep `gateEnv`. Tests: `action-gate.test.ts` (fake bare remote), `agent-env.test.ts`, `gates.test.ts`, the `action gate` repo invariant.

Integration PR (M7.2, M7.3, C8 "green is not safe"; `services/pr-service.ts`, pure parts in `domain/code-council/shipping.ts`): `verifyPr({ record, runDir, drivers, verifier? })` ships from `shipSource(record)`: `synthesis.branch` with `authorFamilies(synthesis, candidates)` (the base candidate, and each graft with a `commitSha`: its donor and its integrator; the trail commit is Concilium's), or, for a run with exactly one candidate and no integration branch, that candidate's `branch` with its family alone; anything else is `BLOCKED`. It reads the branch head (`branchHead`, `refHead`); the commit to ship (`headSha`) is that head, or its parent when the head is `trail.commitSha` and every file it changes `isTrailPath` (`.concilium/runs/`, `TRAIL_PATH_PREFIX`), recorded as `trailSha`. When `changedFiles(base, headSha)` still holds a trail path, the verdict is `BLOCKED` with `headSha: null` (nothing may be pushed). Then its `patchId` against `baseSha` (`git patch-id --stable`). `pickVerifier(authors, usableClis, configured)` returns `{ verifier, notes }`: the configured verifier (`verifier` input: `runtime.resolveVerifier`'s value, `auto` for none) when its CLI is usable and of a known family outside the authors, else the first `usableClis` entry of one, else (with a note when the configured one was passed over) a same-family fallback, the configured one first: a `Verifier` with `sameFamily: true` and `sameFamilyReason` (the type makes the reason required). With `allowSameFamily` (`verifyPr`'s input, `runFactory`'s `allowSameFamilyVerifier`), a usable configured verifier of an author family verifies, flagged `sameFamily` with the opt-in as its reason, so `verification.md`, `pr-body.md`, `pr`/`verify-pr`/`status`/`factory` output warn and the PR stays a draft. `BLOCKED` only when no CLI is usable. In a `detachedWorktree` at `headSha` (a temp dir outside every manifest, removed after), it runs the record's `verification.plan` (`GateRunner.runLane`) and, when the test gate passes, each `evidence`/`regression-guard` adversarial test through `runTestInLane`, its files read from a detached worktree at the adversary's `headSha`; then one read-only `CliCouncilGateway` run of the verifier (`verifierSpec`) on `reviewPrompt` (`VERDICT: PASS|NOTES|FAIL` first, `parseReview`). `decideVerdict`: `FAIL` (a gate passing on the base that does not pass, a valid test not passing, a FAIL review), `BLOCKED` (no review verdict), `PASS+NOTES` (a gate failing on the base too, a NOTES review), `PASS`. The `PrVerdict` (`verdict`, `reason`, `notes`, `verifier`, `authorFamilies`, `branch`, `branchHead`, `headSha`, `trailSha`, `baseSha`, `patchId`, `gates`, `tests`, `review`, `verifiedAt`, `reportPath`) goes to `verification.md` (`verificationMarkdown`, with `sameFamilyWarning` as a bold `Warning:` line) and, from the CLI, to `prVerdict` on the record. `requestPr` throws when `headSha` is null, writes `pr-body.md` (`prBody`: the verdict, the same-family warning, a dissent summary, the trail commit left out of the PR, `synthesis.md`) and requests two `always-pause` gates keyed to `headSha`: `push` of `<headSha>:refs/heads/concilium/<run-id>` (`prBranch`; the verified SHA, never the branch name, so a later commit is never pushed) and `pr` (`gh pr create --head concilium/<run-id> --title <prTitle(task)> --body-file pr-body.md [--base] [--draft]`, a draft when `draftReason` is not null: the verdict is not `PASS`/`PASS+NOTES`, or the verifier is `sameFamily`), recorded as `pr` (`PrRequest`, with `sha` and `draftReason`). Asked again for the same SHA, the keyed gates are reused (`reused`); for another SHA, the pending ones are `superseded`. `prStatus` lists the run's gates and applies `verdictState`: void when the local branch head differs from `branchHead`, or `refs/remotes/<remote>/concilium/<run-id>` when it exists (no network) differs from `headSha`. Merging stays manual. The CLI has `concilium pr <run-id> [--remote origin] [--base <branch>] [--role verifier=<spec>] [--allow-same-family-verifier]`, `concilium verify-pr <run-id> [--role verifier=<spec>] [--allow-same-family-verifier]` (exit 1 unless it passes; a same-family `PASS` exits 0 with a `Warning:` line) and `concilium status <run-id>` (`commands/pr.ts`); each prints the same-family warning. Tests: `shipping.test.ts`, `pr-service.test.ts` (real temp repos, fake bare remote), `pr.test.ts` (fake `claude`/`codex`/`gh` on `PATH`, fake bare remote).

Factory loop (M8.1; `services/factory-service.ts`, pure parts in `domain/code-council/factory.ts`): `runFactory({ spec, specPath, repoDir, planner, verifier?, code, runDir, saveRun })` asks the planner role's CLI (`cli[:model]`) once, read-only through `CliCouncilGateway`, on `planPrompt` (it starts `You are planning`), and `parseTaskAnswer`/`parseTaskList` validate the answer (`{"tasks": [{id, title, type, acceptance, depends_on}]}`) into `FactoryTask`s (`dependsOn`), naming every problem at once in a `TaskListValidationError`: no tasks, a missing id or title, a duplicate id, a type outside `TASK_TYPES`, no non-blank acceptance line, an unknown dependency, a cycle. `taskOrder` puts each task after its dependencies and otherwise keeps the planner's order. `tasks.json` (`{version, specPath, specSha256, tasks}`) and `tasks.md` (`tasksMarkdown`) go to the factory's run dir (`runDir(<factory-id>)`, the CLI's `JsonCodeRunStore.runDir`, so code and factory ids share `<dataDir>/runs/`). Then, one task at a time, `runCodeCandidates` with `task: taskBrief(task)` (the title and each acceptance line), `type`, `verify: true`, `synthesis` and `trail` in the task run's dir, and `baseSha`: `HEAD` for the first task, then the commit the task before it shipped (`startRun({ baseSha })` pins that commit and skips the dirty-tree check; it refuses `includeDirty` with it). `saveRun` saves the record. `unshippable` stops on `reframe-needed`, every candidate not `ok`, or a `shipSource` with nothing to ship; else `verifyPr` (the `verifier` input) verifies at the task's own head and the verdict is saved as `prVerdict`, and `verdictStop` stops unless it is `PASS`/`PASS+NOTES` on a commit. The next base is that verdict's `headSha` (the integration head without the trail commit, or the single candidate's head). Each task's `mergeable` is checked against its own base (`synthesis.mergeTarget`: the factory base for the first task, labelled `the factory base`, then `task <id>'s head`), never the checkout's `HEAD`. The `FactoryRecord` (`factory.json`: `status` `running`/`done`/`stopped`, `specSha256`, `planner`, `baseSha`, `tasks`, `steps` (`shipped` with `runId`, `baseSha`, `branch`, `headSha`, `verdict`, `sameFamily`; `stopped` with `reason`, `runStatus`, `verdict`; `not-run`), `stoppedAt`) is rewritten after every task (`loadFactory`). Nothing is pushed. `concilium factory <spec> [--cwd] [--agents] [--role ...] [--timeout] [--no-adversarial] [--no-judge] [--allow-same-family-verifier] [--json]` (`commands/factory.ts`; the planner is the `planner` code role, the verifier `runtime.resolveVerifier`) prints `factoryLines` (`formatters/factory.ts`): the task table, the stop reason, and `concilium pr <run-id>` per shipped task with `--base concilium/<previous run-id>`; it exits 0 when every task shipped, 2 when one ended in `reframe-needed`, else 1. `concilium status <id>` prints the same for a factory id. Tests: `factory.test.ts` (core, pure), `factory-service.test.ts` (fake drivers, real temp repos: two stacked integration branches, the stop, a rejected list), `git-worktree-workspace.test.ts` (the pinned base), `packages/cli/src/commands/factory.test.ts` (fake `claude`/`codex` on `PATH`).

Learning ledger (M8.2; `services/ledger-service.ts`, pure parts in `domain/code-council/ledger.ts`): there is no ledger file. `ledgerRows(record)` derives the rows of one saved code run from its `run.json` alone, so they agree with its `decisions.tsv`: a `LedgerRow` per run, role and runner (`Runner`: `spec` `cli[:model]`, `provider`, `model`, `family` from `agentFamily`, null for OpenCode on an unknown vendor), with `taskType`, `wallTimeMs` (the candidate's, adversary's or summed integrator `durationMs`; null for the planner, judge and verifier) and per-role `outcome` and `evidence`, a union keyed by `role`. Implementers get one row per candidate (`candidateId`; two candidates of one CLI are two rows); their outcome is `implementerOutcome`, first match of `IMPLEMENTER_OUTCOMES`: `base` (`synthesis.base`, else `ranking.winner`), `grafted` (an applied graft's donor), `dropout` (not `contends`: BLOCKED or disqualified), `gate-failed` (new gate failures), `killed-by-adversary` (`survived < counted`), `outranked`; evidence `verification` (the `verification` row's verdict), `newFailures`, `penalties`, `testsSurvived`, `testsCounted`, `graftsApplied`. Other roles: planner (`rubric.framer`) `framed`/`fallback`; adversary `landed` (an `evidence`/`regression-guard` test of its family), `error` (a failed run with none), `missed`; judge (each tie judgment's `judge` and the graft `picker`, merged per runner) `judged`/`blocked`; integrator (merged per runner) `applied`/`rejected`; verifier (`prVerdict.verifier`) the verdict. `ledgerStats(rows, minSample = DEFAULT_MIN_SAMPLE)` (10) gives `byRunner` (per task type and implementer runner: runs, wins = `base`, `winRate`, outcome counts, `meanWallTimeMs`; best rate first), `byRole` (outcome counts per other role and runner), and per task type either a `RoutingSuggestion` (at least `minSample` distinct runs) or a `WithheldSuggestion` with the reason. A suggestion's `candidates` is a `CandidateSet` (a tuple of at least two runners) built only by `crossFamilySet`: the best runner of each known family by win rate, null for fewer than two families, so a single-family task type is withheld rather than padded. `JsonCodeRunStore.list()` reads every `runs/<id>/run.json` of kind `code` (factories and unreadable files left out). `concilium stats [--cwd] [--min-sample N] [--json]` (`commands/stats.ts`, `formatters/stats.ts`) counts the runs whose `repoDir` is `repoRoot(--cwd)` (exported from the worktree adapter) and prints the win rate table, the other roles and the suggestions (`--agents a,b`) or why each was withheld; exit 1 outside a git repo or for a bad `--min-sample`. Tests: `ledger.test.ts` (pure: outcome order, stats, the sample, every subset of runners never suggests fewer than two families), `ledger-service.test.ts` (a hand-built record per role, `list`), `code.test.ts` (`concilium stats`: the ledger of every run the file made reproduces each run's `decisions.tsv` counts).

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
npx concilium code "add a flag" --no-synthesis   # Rank only: no grafts, integration branch or result.patch
npx concilium code "add a flag" --role judge=codex:gpt-5.2  # Who plays a role (planner, implementer, adversary, judge, integrator)
npx concilium roles                 # The resolved role map and where each role came from
npx concilium gc --dry-run          # Show what gc would remove (worktrees, concilium/ branches)
npx concilium code "add a flag" --no-trail-commit  # Keep decisions.tsv in the run dir, off the integration branch
npx concilium trail check --run <id>  # Check decisions.tsv against events.jsonl and resolve every row's evidence
npx concilium gates                 # Paused actions (push, PR, writes outside concilium/) and their status
npx concilium approve <gate-id>     # Run one paused action's exact command; one approval per gate
npx concilium reject <gate-id>      # Reject one paused action; it never runs
npx concilium pr <run-id> --base main  # Verify, then pause the push of that exact SHA and the PR; rerun reuses the gates
npx concilium verify-pr <run-id> --role verifier=gemini  # Re-verify the commit to ship; exits 1 unless PASS or PASS+NOTES
npx concilium verify-pr <run-id> --role verifier=claude --allow-same-family-verifier  # Opt in to an author-family verifier: flagged, draft PR only
npx concilium status <run-id>       # Gates and the verdict, void once the branch head moved; a factory id shows its tasks
npx concilium factory spec.md --role planner=claude  # Spec to tasks, one verified code run per task, stacked; pushes nothing
npx concilium stats --min-sample 10 # Win rate by task type and runner; cross-family candidate sets after enough runs
```

### Desktop App
```bash
npm run start -w concilium          # Development mode
npm run package -w concilium        # Package app for distribution
npm run smoke -w concilium          # Start the packaged app under xvfb-run with --smoke-test: exit 0 once the window renders with the preload API (Linux)
npm run smoke -w concilium -- --open-run <run-dir>  # Also open a code-run directory and print its rendered ranking (compare with its synthesis.md)
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
| No source file under `packages/` or `desktop/src` builds a `git push` or `gh` command outside `packages/core/src/services/action-gate.ts`; side effects that leave the run go through `ActionGate` (a `kind: 'push'` request is fine) | repo invariants |
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

Config precedence, highest first, per setting: explicit overrides (`run --juror-models`/`--chairman`, the `deliberate()` options `councilModels`/`chairmanModel`/`apiKey`), then environment variable, then (for jurors and chairman, when the runtime is given a `repoDir`) the `juror`/`chairman` roles of the repo's `.concilium/factory.yaml`, then saved config (`concilium config set ...`, which merges into the saved settings), then built-in default (no API key; jurors and chairman left empty for the installed CLIs). `ConfigService.resolve(overrides)` implements it, `createConciliumRuntime` resolves it once per deliberation, fills in the council with `resolveCouncil` and passes it to `DeliberationService`, and `packages/core/src/services/config-service.test.ts` pins it.

## Pre-Submission Checklist
- [ ] Verified offline per `.claude/skills/verify-concilium/SKILL.md`: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint -w concilium` and `node packages/cli/dist/bin/concilium.js --help` all exit 0
- [ ] New behavior has a test, and a fixed bug has a test that failed before the fix
- [ ] If `npm run test:repo` asks you to lower `MISSING_HEADER_BASELINE`, lower it
- [ ] Changes in core don't break cli or desktop (the typecheck covers all three)

## License
All code must be compatible with the MIT License.
