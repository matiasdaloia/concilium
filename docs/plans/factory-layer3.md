# Concilium layer 3 plan: from plan council to code council

Status: draft for review. Written 2026-10-16 on branch `plan/factory-layer3`. Planning only. Nothing in this document has been implemented.

Concilium today runs several coding agents read-only, collects their markdown plans, asks OpenRouter models to rank the plans, and has a chairman model merge them into one plan. Layer 3 changes what the agents produce and how the winner is chosen. Each agent writes real code in its own git worktree. Tests, typecheck, lint, and peer-written adversarial tests decide the ranking, and LLM opinion only scores what the evidence leaves open. The output is a verified, mergeable diff. It comes with a record of the disagreements that were overruled. The agents run through the user's existing CLI subscriptions (Claude Code, Codex CLI, Gemini CLI, OpenCode), so no OpenRouter key is needed.

Layer 3 is the base of a personal "software factory" (spec, then plan, then a council per task, then an integration PR, then a ledger of which model wins which task type). It may later be used inside SCANOSS.

Terminology used here. "Layer 1" is the parallel agent run (Stage 1 today). "Layer 2" is peer ranking plus chairman synthesis (Stages 2 and 3 today). "Layer 3" is the code council described in Part B. These names are an assumption of this document. Rename them if the project already uses other names.

## How to read this

- Part A is the audit. Every finding cites a file and, where it matters, a line.
- Part B is the layer 3 design: data shapes, ports, and the run lifecycle.
- Part C maps the pstack patterns (arena, swarm, playbooks, shipping) onto the design.
- Part D is the milestone list. One milestone is one small verifiable unit with acceptance criteria. Lessons from Part C are folded in where they apply, tagged `[pstack:n]`.
- Parts E and F hold risks and open questions.
- Appendix A says what this audit verified and what it did not.

---

## Part A. Audit of the current architecture

### A1. What the system does today

```
                 ┌──────────── Stage 1 (layer 1) ────────────┐
prompt ──wrap──► │ ClaudeProvider  CodexProvider  OpenCode…  │  read-only, same cwd
 (prompts.ts)    │   (claude CLI)   (codex SDK)   (SDK server)│  output = markdown plan
                 └──────────────────────┬────────────────────┘
                                        ▼
                 ┌──── Stage 2 (layer 2) via OpenRouter ─────┐
                 │ N juror models rank anonymized plans      │  regex-parsed "FINAL RANKING"
                 └──────────────────────┬────────────────────┘
                                        ▼
                 ┌──── Stage 3 via OpenRouter ───────────────┐
                 │ chairman merges plans + reviews into one  │  markdown, no verification
                 └──────────────────────┬────────────────────┘
                                        ▼
                         RunRecord JSON (JsonRunRepository)
```

The orchestration lives in `packages/core/src/services/deliberation-service.ts` (`DeliberationService.run`). Stages 2 and 3 live in `packages/core/src/domain/deliberation/pipeline.ts` (`runCouncilStages`). All prompts live in `packages/core/src/domain/deliberation/prompts.ts`.

Size. About 17.6k lines across `packages/` and `desktop/src` (assets included). Core is about 2.6k lines of TypeScript. The largest files are desktop screens (`AnalyticsScreen.tsx` 1130 lines, `HomeScreen.tsx` 711, `RunningScreen.tsx` 680) and `opencode-provider.ts` (510).

### A2. Core ports and adapters

The hexagonal split is real and worth keeping. Core does not import CLI or Electron code, and both shells inject their own adapters.

| Port (`packages/core/src/ports/`) | Shape | Implementations | Assessment |
|---|---|---|---|
| `agent-provider.ts` `AgentProvider` | `discoverModels()`, `execute(config) → AgentResult` | `adapters/claude-provider.ts` (spawns `claude --print --output-format stream-json`), `adapters/codex-provider.ts` (`@openai/codex-sdk`), `adapters/opencode-provider.ts` (`@opencode-ai/sdk`, embedded server) | Good seam. The result type is plan-shaped (`normalizedPlan: string`). It has no notion of workspace, diff, commit, or head SHA. Layer 3 needs a different result type. |
| `llm-gateway.ts` `LlmGateway` | `query`, `queryStreaming`, `queryModelsParallelStreaming`, `fetchModels`, cache helpers | `adapters/openrouter-gateway.ts` | OpenRouter-specific concerns leak into the port (`OpenRouterModelInfo`, `fetchModels`, `getCachedOrFallbackModels`). It takes no `AbortSignal`, so Stages 2 and 3 cannot be cancelled. |
| `deliberation-events.ts` `DeliberationEvents` | 9 callbacks, hard-wired to 3 stages and "jurors" | CLI `adapters/callback-event-bridge.ts`, desktop `main/adapters/electron-event-bridge.ts` | Works, but stage numbers and juror vocabulary are baked in. Layer 3 has more phases. A typed event union (`{type: 'phase', ...} \| {type: 'candidate', ...}`) scales better than more methods. |
| `run-repository.ts` `RunRepository` | `save/load/list/loadAll` | `adapters/json-run-repository.ts` | One JSON file per run. `load(id)` joins an unvalidated id into a path (`json-run-repository.ts:62`), and the desktop passes a renderer-supplied id (`desktop/src/main/ipc.ts:116`). Low risk, but validate the id. |
| `config-store.ts` `ConfigStore` | council prefs, agent instances, `lastOpencodeModel` | `adapters/json-config-store.ts` | Provider list duplicated in `isValidAgentInstance`. `getLastOpencodeModel` is a UI preference sitting in a domain port. |
| `secret-store.ts` `SecretStore` | `encrypt/decrypt` | `adapters/plaintext-secret-store.ts`, CLI `adapters/terminal-secret-store.ts`, desktop `adapters/electron-secret-store.ts` | The CLI's `TerminalSecretStore` is byte-for-byte the same as `PlaintextSecretStore` (base64). The CLI stores the OpenRouter key as base64 in `config.json`. It becomes moot once subscription CLIs replace API keys. |

Services. `ConfigService` resolves env over prefs over defaults. `ModelDiscoveryService` asks each provider for models. `DeliberationService` composes everything.

### A3. Findings in core (domain and adapters)

Correctness defects, highest impact first:

1. **Agent identity collides when two agents share a display name.** `deliberation-service.ts:109` keys Stage 1 results by `r.name`, and the name is built from provider plus model. The default agent set in both the CLI (`packages/cli/src/commands/run.ts:55`) and the config store (`json-config-store.ts`, `createDefaultAgentInstances`) is two `opencode` instances with an empty model. Both are named `opencode`. `labelToModel` then maps two labels to the same name, so `calculateAggregateRankings` (`ranking.ts`) merges their positions. `modelSnapshots[agent.name]` (`deliberation-service.ts:165`) overwrites one with the other. The default configuration produces a wrong leaderboard.
2. **Cost attribution matches an empty model id to any model.** `deliberation-service.ts:160` finds pricing with `fullModelId.endsWith(m.id) || m.id.endsWith(fullModelId)`. For `fullModelId === ''`, `m.id.endsWith('')` is always true, so the first cached OpenRouter model's price is attributed to the agent. It also applies OpenRouter API pricing to subscription CLIs, which do not bill per token.
3. **OpenCode likely ignores the selected working directory.** `opencode-provider.ts:365` creates a session without a directory, and the embedded server (`createOpencodeServer`, line 78) is a process-wide singleton started from the host process's cwd. Commit `5d80a3f` ("make cwd selectable") passes `cwd` to every `AgentConfig`, but nothing in the OpenCode adapter reads `agent.cwd`. Needs a repro (Appendix A). If confirmed, OpenCode agents research the wrong repository whenever `--cwd` or the desktop picker differs from the process cwd.
4. **Ranking prompt anchors the judges.** `prompts.ts` (`buildRankingPrompt`) shows a format example of `1. Response C / 2. Response A / 3. Response B` right before asking for the real ranking. Example orderings bias LLM judges. The aggregate is a plain mean rank (`ranking.ts:51`). Partial rankings, judges that skip a label, and ties are not handled.
5. **Images reach only OpenCode.** `ClaudeProvider` and `CodexProvider` ignore `config.images`. The CLI always passes `images: []` (`run.ts`, both modes).
6. **Cancellation is partial.** `RunController` registers a fake `ChildProcess` cast from an object literal (`agent-executor.ts:135`) to reuse a kill path. OpenRouter calls only use `AbortSignal.timeout`, so cancel during Stages 2 and 3 does nothing until the timeout.
7. **Errors are swallowed in config.** `config-service.ts:30-35` drops a failed decrypt silently, which contradicts the AGENTS.md rule "never swallow errors". The custom error classes in `shared/errors.ts` (`ConciliumError`, `ConfigError`, `PipelineError`, `AgentError`) are exported but never thrown anywhere in the repo.

Design debt that layer 3 must remove:

8. **Read-only is the core assumption.** The research wrapper says "NEVER write, edit, create, or delete any files" (`prompts.ts:8`). Claude runs with `--permission-mode plan` and disallowed write tools (`claude-provider.ts:20`). Codex runs `sandboxMode: 'read-only'` (`codex-provider.ts:159`). OpenCode gets a read-only tool map and a duplicated system prompt (`opencode-provider.ts:434`). All agents share one `cwd` (`deliberation-service.ts:71`). That is safe only because nobody writes. Layer 3 inverts it.
9. **Provider identity is hardcoded in at least six places.** `AgentId` and `AgentProviderType` in `domain/agent/agent-config.ts`, `isValidAgentInstance` in `json-config-store.ts`, string casts in `cli/src/commands/run.ts` and `cli/src/index.ts`, `DEFAULT_AGENT_MODELS`, `supportsDiscovery: id === 'opencode'` in `model-discovery-service.ts`, and the desktop copy in `desktop/src/renderer/types/index.ts`. Adding Gemini CLI today means editing all of them. A provider registry (one table keyed by provider id, holding capabilities) removes the scatter.
10. **Model catalogs are static code.** `CLAUDE_MODELS` and `CODEX_MODELS` (`agent-executor.ts:159`, `:169`) and `DEFAULT_COUNCIL_MODELS` (`council-config.ts:14`) are literals in the domain layer. Model catalogs belong in config or discovery, not in `domain/`.
11. **The Codex binary is resolved by walking up from `process.cwd()`** (`codex-provider.ts`, `resolveCodexBinaryPath`). This works around Vite bundling. It is cwd-dependent and runs at module load. Driving the user's installed `codex` CLI removes it.
12. **Agent results are text only.** `AgentResult.normalizedPlan` is the only payload. Events are kept in full in the run JSON. There is no per-agent artifact directory, transcript file, or diff.
13. **The stage pipeline is a fixed function.** `runCouncilStages` returns a tuple `[Stage2Result[], Stage3Result, RunMetadata]` and encodes degraded modes as fake chairman responses (`model: 'chairman-unavailable'`). Layer 3 needs a phase machine with explicit states (framed, fanned-out, verified, judged, integrated, reframe-needed), not more tuple slots.
14. **No timeout on Claude and Codex runs.** OpenCode has a 120 s inactivity timeout (`opencode-provider.ts`, `streamSessionEvents`). That is too short for coding tasks where a test suite can be silent for minutes. Claude and Codex have no timeout at all.

### A4. The CLI (`packages/cli`)

- Entry `bin/concilium.ts` registers `run`, `history`, `config`, `models`. AGENTS.md, README.md, and CHANGELOG.md all document a `gui` command that does not exist.
- `--stage1-only`, `--jurors <n>`, and `--format <type>` are declared (`run.ts:83`, `:85`, `:88`) and documented in `packages/cli/README.md:63-68`, but no code reads them.
- The composition root is written three times: `buildProviders()` plus wiring in `cli/src/commands/run.ts`, again in `cli/src/index.ts` (`deliberate()`), and again in `desktop/src/main/ipc.ts`. Each copy picks its own secret store and repository.
- The no-op repository for `--no-save` is an inline object literal with a `{} as RunRecord` cast, duplicated in `run.ts` and `index.ts`.
- `run.ts` has two event-bridge implementations (Ink reducer and console) inline in one 291-line action. The Ink path is decent (`ui/hooks/useDeliberation.ts` reducer).
- `deliberate()` in `cli/src/index.ts` is a useful programmatic entry point. Layer 3 should keep an equivalent (`council.code(...)`), because the factory will call it as a library.

### A5. The desktop app (`desktop/`)

- Electron Forge plus Vite, React 19, Tailwind 4. `contextIsolation: true` and `nodeIntegration: false` (`desktop/src/main/main.ts:44-45`) are set correctly.
- `desktop/src/renderer/types/index.ts` redefines core types by hand. They have already drifted. `rawOutput` is required there and optional in core.
- `desktop/package.json` depends directly on `@openai/codex-sdk` and `@opencode-ai/sdk` although only core uses them. `nodejs-whisper` (voice dictation) pulls a native toolchain into a product whose main loop is now terminal agents.
- Lint uses ESLint 8 with `@typescript-eslint` v5 and a legacy `.eslintrc.json`. ESLint 8 reached end of life in October 2024.
- The desktop is versioned `1.3.0` and core and CLI are `2.1.1`.
- The analytics screen (`AnalyticsScreen.tsx`, `utils/analytics.ts`) is the only place that aggregates "which model wins". Its input is LLM rankings plus optional user feedback (`run:saveUserFeedback`). That is the seed of the factory's learning ledger, but its signal is opinion, not evidence.

Recommendation: freeze desktop feature work during layer 3. Build layer 3 CLI-first and artifact-first. The desktop can later render run directories read-only (milestone M9).

### A6. Cross-cutting tech debt

- **No tests.** There are zero `*.test.ts` or `*.spec.ts` files in the repo. AGENTS.md points at `packages/core/src/domain/deliberation/ranking.test.ts`, which does not exist. `npm test` runs `vitest run` in core and desktop with nothing to run.
- **No CI.** There is no `.github/` directory.
- **Non-reproducible installs.** `.gitignore` excludes `package-lock.json` (commit `1602083`). A factory that judges code by running tests cannot itself have floating dependencies.
- **Build artifacts and local settings are committed.** `packages/core/tsconfig.tsbuildinfo` and `.claude/settings.local.json` are tracked.
- **Toolchain config is split.** `desktop/tsconfig.json` does not extend `tsconfig.base.json`.
- **`engines.node >= 18`** in core and CLI. Node 18 reached end of life in April 2025 and Node 20 in April 2026. The dev machine runs Node 24.19.
- **Documentation drift.** AGENTS.md and README describe a `gui` command, test files, and flags that do not exist. Agents working in this repo read those docs first, so the drift costs every agent run.

### A7. What is outdated as of October 2026

The project's code dates from February 2026 (first commit `v0.1.0`, 2026-02-07). Its dependency and model choices are older than that.

| Area | In repo | Why it is stale | Action |
|---|---|---|---|
| Claude models | `claude-opus-4-6`, `claude-sonnet-4-5-20250929`, `claude-haiku-4-5-20251001` (`agent-executor.ts:159`) | The current family is Claude 5 (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1). | Stop hardcoding. Pass aliases through to the CLI and discover where the CLI allows. |
| Codex models | `gpt-5.2-codex` and older (`agent-executor.ts:169`) | Eight months old. Not verified against current Codex. | Same. Let the installed CLI default win unless configured. |
| Council defaults | `openai/gpt-5.2`, `google/gemini-3-pro-preview`, `anthropic/claude-opus-4.6` (`council-config.ts:14-20`) | Preview ids and stale versions. | Move to config. Layer 3 judges come from per-role config (Part B5). |
| OpenRouter fallback list | `gpt-4o`, `claude-3.5-sonnet`, `gemini-1.5-pro`, `llama-3.1` (`openrouter-gateway.ts:9`) | 2024-era models. Older than the project itself. | Delete the fallback. Show "unavailable" instead of fake data. |
| Gemini CLI | absent | It is one of the four subscriptions in scope. | New adapter (M1.4). |
| `@openai/codex-sdk` ^0.98, `@opencode-ai/sdk` ^1.1.53 | pinned in core and desktop | Fast-moving pre-1.0 and 1.x SDKs. Event shapes change between minors. | Drive the installed CLIs headlessly. Keep SDKs only where they add something the CLI cannot do. |
| Electron 40.2.1 | `desktop/package.json` | Electron ships a major roughly every 8 weeks and supports the latest three. 40 is very likely out of support by now (not verified). | Upgrade when desktop work resumes (M9). |
| ESLint 8 + `@typescript-eslint` v5 | `desktop/` | ESLint 8 end of life October 2024. No lint for core or CLI. | Flat config at the root covering all workspaces (M0.1). |
| TypeScript `~5.7` | all packages | Pinned to an old minor. The current major was not checked here. | Upgrade in M0.1 behind a green typecheck. |
| Node `>=18` | `engines` | Node 18 and 20 are end of life. | `>=22`, test on 24. |

### A8. Keep, change, delete

- **Keep.** The ports and adapters split, the `AgentProvider` seam, the event port idea, JSON run records, the Ink UI reducer, Claude stream-json parsing (`adapters/parsers/claude-parser.ts`), and the programmatic `deliberate()` entry point.
- **Change.** `AgentResult` (text) becomes `CandidateResult` (workspace, commits, head SHA, report). `DeliberationEvents` becomes a typed event union. `runCouncilStages` becomes one mode of a phase machine. Provider identity moves into a registry.
- **Delete.** `TerminalSecretStore` (duplicate), the OpenRouter fallback model list, the unused error classes (or start using them), the unused CLI flags (or implement them), the Codex binary resolver, the fake `ChildProcess` in `RunController`, and the stale docs.

---

## Part B. Layer 3 design

### B1. Goals and non-goals

Goals:

1. Every candidate writes code in its own git worktree, branched from one pinned base SHA. The user's checkout is never written to.
2. Candidates run through the user's installed, subscription-authenticated CLIs (Claude Code, Codex CLI, Gemini CLI, OpenCode) in headless mode. No API key is required for any role.
3. Ranking comes from evidence first. Hard gates (typecheck, lint, existing tests) run on every branch. Peer-written adversarial tests run on every branch. LLM judges score only the rubric criteria evidence cannot settle, and they see the evidence.
4. Synthesis is code. The best branch becomes the base. One or two named ideas from the losing branches are grafted by hand. The integrated branch is re-verified. The output is a branch plus a patch that applies cleanly to the target.
5. Disagreement is output. Judges who disagreed with the pick, adversarial tests the winner still fails, and rejected grafts are kept as structured dissent records.
6. Every run leaves a decision trail a reviewer can audit without the transcript.

Non-goals for layer 3:

- Pushing, opening PRs, or merging. The run stops at a local, verified branch. PR creation arrives in M7 behind an explicit pause gate.
- Multi-task decomposition (spec to task DAG). That is the factory loop in M8.
- Desktop UI. CLI and artifacts first.

### B2. Data shapes

Name the shapes first. The run is a state machine over these types. It is not a set of flags.

```ts
// Who runs a role. Family exists so panels can be checked for cross-family coverage.
type CliKind = 'claude-code' | 'codex' | 'gemini' | 'opencode';
type ModelFamily = 'anthropic' | 'openai' | 'google' | 'other';
interface RunnerRef { cli: CliKind; model?: string; family: ModelFamily }

type Role = 'candidate' | 'adversary' | 'judge' | 'integrator' | 'verifier' | 'framer';

type TaskType = 'bug-fix' | 'feature' | 'refactor' | 'perf' | 'prototype';

interface TaskSpec {
  id: string;
  type: TaskType;
  goal: string;              // one sentence, executable by a stranger
  acceptance: string[];      // checkable lines
  repo: string;              // absolute path of the target repo
  baseSha: string;           // pinned before fan-out
  scope: { write: string[]; forbid: string[] };   // globs
}

interface RubricCriterion { id: string; question: string; weight: number; evidence: 'gate' | 'adversarial' | 'judgment' }
interface Rubric { criteria: RubricCriterion[]; frozenAt: string; sha256: string }  // 3..6 criteria, frozen before fan-out

interface Workspace { id: string; path: string; branch: string; baseSha: string }

type ReportStatus = 'PASS' | 'ISSUES' | 'BLOCKED';
interface WorkerReport {
  status: ReportStatus;
  headSha: string;           // exact SHA the claim is about
  ran: string[];             // commands actually executed
  evidence: EvidenceRef[];
  rationale: string;         // alternatives considered and rejected
}

interface GateResult { gate: string; command: string[]; sha: string; exitCode: number; durationMs: number; logPath: string }
type EvidenceRef = { kind: 'gate' | 'test' | 'diff' | 'log' | 'commit'; path: string; sha?: string };

interface AdversarialTest { id: string; author: string /* candidate id */; targets: string[]; path: string; specClause: string }
// matrix[testId][candidateId] = pass | fail | error
type SurvivalMatrix = Record<string, Record<string, 'pass' | 'fail' | 'error'>>;

interface Dissent {
  id: string;
  raisedBy: { role: Role; runner: RunnerRef };
  against: 'base-pick' | 'graft' | 'graft-rejection' | 'rubric' | 'test-validity';
  claim: string;
  evidence: EvidenceRef[];
  resolution: 'overruled' | 'accepted' | 'open';
  resolutionReason?: string;
}

type RunPhase =
  | 'framed' | 'fanned-out' | 'verified' | 'attacked' | 'judged'
  | 'integrated' | 'reverified' | 'done' | 'reframe-needed' | 'failed';
```

The shapes follow Model the Domain and Type System Discipline. `RunPhase` is a single discriminated state, replacing the tuple-and-sentinel style of `runCouncilStages`. `WorkerReport` always carries `headSha`, so a claim cannot float free of the code it describes. `Rubric.sha256` lets later phases prove the rubric did not change after fan-out.

### B3. New ports

All new ports go in `packages/core/src/ports/`. Domain logic goes in `packages/core/src/domain/code-council/`. The existing plan council stays as it is and becomes the "plan" step of the factory (M8).

| Port | Responsibility | First adapter |
|---|---|---|
| `headless-agent.ts` `HeadlessAgent` | Run one role on one brief in one directory. Stream events. Return a `WorkerReport`. Fresh process per call, never a resumed session. | `adapters/cli/{claude-code,codex,gemini,opencode}.ts` |
| `workspace.ts` `WorkspaceManager` | Create, list, and remove worktrees from a base SHA. Collect diff, commits, and head SHA. Idempotent cleanup. | `adapters/git-worktree-workspace.ts` |
| `verifier.ts` `GateRunner` | Detect and run project gates in a workspace at a SHA. Write logs. Return `GateResult[]`. | `adapters/command-gate-runner.ts` (child processes, optional sandbox wrapper) |
| `run-store.ts` `RunStore` | Run directory layout (B9), append-only decision trail, artifacts. Replaces the single-JSON `RunRepository` for code runs. | `adapters/fs-run-store.ts` |
| `autonomy.ts` `ActionGate` | Classify an action as proceed or pause. Record pauses as gate entries. | `adapters/policy-action-gate.ts` |

`HeadlessAgent` is a new port, not a change to `AgentProvider`. The plan council keeps `AgentProvider` until the CLI adapters can serve both. Then the old providers are migrated and deleted in one wave (Migrate Callers Then Delete Legacy APIs, M1.6).

```ts
interface HeadlessAgent {
  readonly cli: CliKind;
  probe(): Promise<CliCapabilities>;            // version, auth, flags, sandbox modes
  run(input: {
    runner: RunnerRef;
    role: Role;
    briefPath: string;                           // brief is a file; the prompt only points at it
    cwd: string;                                 // a worktree, never the user's checkout
    access: 'read-only' | 'workspace-write';
    timeoutMs: number;
    signal: AbortSignal;
    onEvent: (e: AgentEvent) => void;
  }): Promise<WorkerReport>;
}
```

### B4. Worktrees

- **Location.** `$XDG_CACHE_HOME/concilium/worktrees/<repo-hash>/<run-id>/<candidate-id>` (CLI) or the desktop `userData` equivalent. Never inside the target repo's working tree, so the user's `git status` stays clean and tooling does not index the copies.
- **Branches.** `concilium/<run-id>/<candidate-id>`, plus `concilium/<run-id>/integration`. All local. Nothing is pushed.
- **Base pinning.** Record `baseSha = git rev-parse HEAD` at framing. Refuse to start on a dirty tree unless `--include-dirty` is passed. That flag snapshots the dirty tree to a temporary commit on a scratch ref, so every candidate starts from the same bytes.
- **Dependencies.** A fresh worktree has no `node_modules` and no build cache. Run the project's install command once per worktree, using hardlinks or a shared store where the package manager supports it (pnpm store, `npm ci` with a warm cache, `uv` cache). Measure the cost in M2. It decides how many candidates are affordable.
- **Cleanup.** `concilium gc` removes worktrees and branches of finished runs (keeping the integration branch until the user deletes it). It is idempotent and recovers from crashes using `git worktree list --porcelain` plus the run store. Deleting a branch that is not under `concilium/` always pauses (B10).

### B5. Subscription CLI adapters

The aim is to drive each CLI exactly as the user would in a terminal, under the user's own login. Each adapter has the same three parts. A `probe()` that reads `--version` and auth status and checks the flags the adapter needs. A command builder. A stream parser that turns the CLI's JSON events into `AgentEvent`.

The invocations below are starting points. They are not verified in this audit, because the CLIs could not be run here (Appendix A). M1.1 builds a capability probe that confirms each flag against the installed version before any adapter depends on it. Record the result in the probe fixtures.

| CLI | Headless invocation (verify in M1.1) | Write access in a worktree | Notes |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json --verbose --no-session-persistence --model <m>` with `cwd` set to the worktree. Read-only roles keep `--permission-mode plan` (today's behavior). Writers use a scoped `--allowedTools` list or `acceptEdits`, never a blanket bypass. | Edits limited to the cwd. Bash limited by an allowlist of the project's gate commands. | Today's parser `adapters/parsers/claude-parser.ts` carries over. Images can be passed as file paths in the brief. |
| Codex CLI | `codex exec --json --sandbox workspace-write --cd <worktree> -m <m> <prompt>` (read-only roles: `--sandbox read-only`). | The Codex sandbox confines writes to the workspace. Network stays off by default. | Replaces `@openai/codex-sdk` and `resolveCodexBinaryPath`. The event names today (`thread.started`, `item.*`, `turn.completed`) come from the same JSONL stream, so `mapCodexEvent` mostly carries over. |
| Gemini CLI | `gemini -p <prompt> --output-format stream-json` (or `json`), with an approval mode that allows edits but not arbitrary shell. | Run inside the worktree. Add the sandbox flag if the installed version has one. | New. Gives the panel a Google-family runner without an API key. |
| OpenCode | `opencode run --format json --model <provider/model>` with `cwd` set to the worktree, or one server per worktree with the session directory set explicitly. | Tool map per role (read-only roles keep today's `READONLY_TOOLS`). | Fixes finding A3.3 by construction. OpenCode can also route to API-key providers. Mark those runs as such in the ledger, since they are not subscription runs. |

Rules shared by all four adapters:

- **One brief file per invocation.** The prompt argument says "Read `<brief path>` and follow it." It does not inline megabytes of context. Briefs live in the run store, so a reviewer can read exactly what each agent was told.
- **Fresh process per round.** No `--resume` or `--continue`. Each round gets a new process with a consolidated brief (Part C, lesson 7).
- **Environment scrubbing.** Pass only what the CLI needs (`HOME`, `PATH`, the CLI's config dir, locale). Do not forward `OPENROUTER_API_KEY`, cloud credentials, or `GH_TOKEN` to candidate processes.
- **Timeouts are per role and wall-clock.** Use an inactivity timeout only for the event stream, not for gate commands that can be silent for minutes.
- **Quota awareness.** Subscription plans have rolling usage windows. The probe records the plan where the CLI exposes it. The scheduler caps concurrency per CLI (default 2) and treats a rate-limit message as `BLOCKED` with a retry-after, not as a candidate failure.

The plan council's juror and chairman calls move to the same adapters in read-only mode (M1.6). OpenRouter stays as an optional `LlmGateway` adapter for users who prefer API keys. It is no longer required.

### B6. Verification-based judging

Judging runs in four tiers. Each tier only orders what the previous tier left tied.

**Tier 0. Integrity checks (deterministic, no LLM).** On each candidate diff against `baseSha`:

- Did it write outside `scope.write` or touch `scope.forbid`?
- Did it delete or weaken existing tests? Signals include a removed test file, a new `.skip`, `.only`, `xit`, `@Disabled`, or `t.Skip`, and lowered coverage thresholds.
- Did it edit gate configuration (lint rules, `tsconfig` strictness, CI files) without the task asking for it?
- Did it add dependencies?

A violation produces `ISSUES` with the offending hunk as evidence. Weakening tests disqualifies the candidate. Everything else is a scored penalty.

**Tier 1. Hard gates.** `GateRunner` detects gates from the repo (`package.json` scripts named `typecheck`, `lint`, `test`, `Makefile` targets, `go vet`/`go test`, `pytest`, `cargo test`). It merges them with an optional `.concilium/verify.yaml` committed in the target repo, which overrides detection. Every gate runs on every candidate at its head SHA, plus once on `baseSha` for a baseline. A gate that already fails on the base is reported, not held against candidates. The rule is "no new failures against base".

**Tier 2. Adversarial tests.** After the gates, each candidate's author family gets a fresh adversary process. It runs read-only over the other candidates' diffs and write-only in its own scratch worktree, and it writes tests that target the spec's acceptance lines and the peers' weak spots. Every adversarial test must name the acceptance line (`specClause`) it enforces.

- Each test runs against every candidate and against the base. The result is the `SurvivalMatrix`.
- **Validity rule.** A test that fails on the base and passes on at least one candidate is evidence. A test that fails on every candidate and on the base is quarantined, and the judge tier decides whether it is a real gap (a dissent record) or an invalid test (dropped with a reason). A test that passes on the base is vacuous for a bug fix and dropped. For feature work it is kept as a regression guard.
- An author's own tests are run but carry no weight for that author.

**Tier 3. Rubric judgment.** A judge panel scores only the rubric criteria marked `evidence: 'judgment'`, such as maintainability, fit with existing patterns, and clarity of boundaries. Each judge gets an evidence pack (the diffs, gate results, survival matrix, integrity flags, and the frozen rubric). Judges are blind to which CLI and model produced which diff. The panel must include at least one family that wrote none of the candidates where possible, and never only the same family as the leading candidate. Each judge scores criterion by criterion with a one-line evidence pointer per score. The parsed output is JSON validated against a schema, not regex over prose, and there are no example orderings in the prompt (fixes A3.4).

**Score.** Lexicographic: integrity disqualifications, then gate pass (no new failures), then valid adversarial survival rate, then weighted rubric score. Ties go to the smaller diff with the cleaner boundary. Every number in the final ranking points at the evidence row that produced it.

### B7. Code-level synthesis

1. **Pick the base.** Take the top candidate under B6. If two are within a tie margin, pick the one a future maintainer can extend most easily: fewer files, smaller surface, no new dependencies, and alignment with existing patterns per the judges' maintainability scores. Compare the parent's pick against the cross-family judge's recommendation. Disagreement is logged as a dissent record with both rationales.
2. **Choose grafts.** Read each losing candidate once more and name at most one or two ideas per loser. Typical grafts are an edge case it handled, an adversarial test it wrote that the base fails, or a cleaner helper. Each graft is written as a short instruction with a source commit or hunk reference.
3. **Integrate.** Create `concilium/<run-id>/integration` from the base candidate's head. Spawn a fresh integrator process in that worktree with a brief that lists the grafts. The integrator folds each graft in by hand so the result stays coherent. Mechanical cherry-picks are not allowed. One commit per graft, so any graft can be reverted alone.
4. **Re-verify.** Run all gates and the full valid adversarial suite on the integration head. A graft that causes a regression against the base is reverted and recorded as a rejected graft with the failing evidence.
5. **Emit.** The outputs are the integration branch, `result.patch` (`git format-patch <baseSha>..<integration-head>`), and a mergeability check against the target's current `HEAD` (`git merge-tree` or `git apply --check`). If the target moved since `baseSha`, rebase the integration branch in its worktree and re-verify. A patch is called "mergeable" only when re-verification at the new base passes.
6. **Divergence means reframe.** Averaging is not allowed. If no candidate passes the gates, if the survival matrix shows each candidate failing a different disjoint set of tests, or if the judges' base picks spread across all candidates, the spec was underspecified. The run ends in `reframe-needed` with the concrete questions the divergence exposed (which acceptance lines the candidates interpreted differently). It does not ship a blend.

### B8. Recorded dissent

Dissent is a first-class output, stored in `dissent.json` and rendered in `synthesis.md`. Sources:

- A judge whose recommended base differs from the pick.
- A valid adversarial test the integration head still fails (accepted risk or open).
- A quarantined test the judges could not classify.
- A rejected graft and its evidence.
- A rubric criterion where judges' scores differ by more than a set spread.

Each record has `resolution` and `resolutionReason`. "Overruled" requires a reason that points at evidence. `open` dissent is surfaced at the top of the final report and blocks the "mergeable" label when it concerns an acceptance line.

### B9. Run artifacts

```
$XDG_DATA_HOME/concilium/runs/<run-id>/
  spec.md                 TaskSpec, rendered
  playbook.md             the task-type playbook, copied verbatim
  rubric.json             frozen before fan-out, sha256 recorded
  briefs/<role>-<n>.md    exactly what each process was told
  candidates/<id>/report.json  diff.patch  events.jsonl
  evidence/<sha>/<gate>.log
  adversarial/<test-id>.*  matrix.json
  judges/<n>.json
  dissent.json
  decisions.tsv           show-me-your-work format, append-only
  synthesis.md            base, grafts (with source), rejections, dropouts, verification result
  result.patch
```

A copy of `decisions.tsv`, `synthesis.md`, and `dissent.json` is committed on the integration branch under `.concilium/runs/<run-id>/`. That way the trail ships with the change (Part C, lesson 6). Make that commit configurable for repos that do not want it.

### B10. Autonomy tiers

| Tier | Examples | Behavior |
|---|---|---|
| Proceed | Create a worktree or branch under `concilium/`. Run CLIs and gates in a worktree. Write to the run store. Revert a graft. Run `gc` on finished runs. | Runs without asking and is logged. |
| Proceed and announce | Install dependencies in a worktree. Rebase the integration branch onto a moved target. | Runs and prints a one-line notice. |
| Always pause | Push to any remote. Open, merge, or close a PR. Write to the user's checkout or any branch outside `concilium/`. Delete anything outside the run's own worktrees and branches. Deploy. Send a message to a person. | Written as a gate entry (`gates.md`) with the exact command. Requires explicit approval and is never inferred from an earlier approval. |

`ActionGate` enforces this table in code. Candidate CLIs cannot push because their environment has no credentials (B5), and the orchestrator itself routes every git and network side effect through `ActionGate`.

---

## Part C. Lessons from pstack

Sources read for this section: `~/.claude/skills/arena/SKILL.md`, `~/.claude/skills/swarm/SKILL.md`, and from `~/.claude/plugins/cache/pstack-claude/pstack/0.9.34/skills/`, `poteto-mode/SKILL.md`, `poteto-mode/playbooks/{bug-fix,feature,refactoring,perf-issue,prototype,shipping,orchestrate,autonomous-run,multi-phase-plan}.md`, and `show-me-your-work/SKILL.md`.

pstack runs these patterns as prompts to one coordinating agent. Concilium should encode them as code and data, so they hold whichever CLI is driving. This follows pstack's own principle "Encode Lessons in Structure".

### C1. Playbook routing by task type

pstack routes every task to a playbook whose steps are copied verbatim into the todolist, and a skipped step stays with `skip: <reason>`. The task types map to `TaskType`:

| `TaskType` | pstack playbook | Fixed steps Concilium injects into every brief for that type |
|---|---|---|
| `bug-fix` | Bug fix | Reproduce on the matching surface first. Binary-search the cause with runtime evidence. Smallest change the evidence justifies. Failing repro lands before the fix in history. Verify the original repro now passes. |
| `feature` | Feature | Name the data shape first. Throughput checkpoint (blocking steps, independent workstreams, shared state, smallest decomposition). Small ordered commits. Verify on the matching surface. |
| `refactor` | Refactoring | Pin behavior with a characterization test before moving structure. Subtract before adding. Small behavior-preserving steps, pin green each step. Equivalence proof. Revert if reader load did not drop. |
| `perf` | Perf issue | Baseline measurement first. Hypotheses from the trace. Post-fix measurement on the same probe. Cite numbers. |
| `prototype` | Prototype | Name the decision. Throwaway code in scratch. Variants side by side. The output is a decision plus evidence, not mergeable code. |

Implementation. `packages/core/src/domain/code-council/playbooks/<type>.md` hold the step text. A `PlaybookRegistry` table maps `TaskType` to steps, the default rubric criteria, and the gate emphasis. Examples: `bug-fix` requires a failing-then-passing repro test, `refactor` requires a characterization pin and treats any behavior change found by adversarial tests as a disqualifier, and `perf` requires a benchmark gate on base and head. Candidate reports must list each step as done, or skipped with a reason. A missing step is an integrity `ISSUES`. The `prototype` type is excluded from synthesis. Its output is a decision record, not a patch. (M3.1)

### C2. Arena: candidates, rubric, cross-family judge, base, graft, re-verify

The arena skill is the closest match to layer 3. Its phases map directly.

| Arena phase | Concilium phase | Rule carried over |
|---|---|---|
| A. Frame | `framed` | Same brief to all candidates. The rubric of 3 to 6 gradeable criteria is written before fan-out. Candidates see the task, not the rubric. Each candidate gets its own output location (a worktree). |
| B. Fan out | `fanned-out` | All candidates spawn together. Each produces the artifact plus a rationale naming the alternatives it rejected. A dropout continues with N-1 and is recorded. |
| C. Cross-judge | `judged` (Tier 3) | The judge runs after all candidates finish, on a different family from the parent, and recommends a base. |
| D. Pick | B7.1 | Score criterion by criterion, not on feel. Agreement with the judge confirms. Disagreement is read, not averaged. Pick by maintainability. |
| E. Graft | B7.2 to B7.3 | One or two ideas per loser, folded in by hand, recorded with their source. Convergence of all candidates is a strong signal and needs no graft. Wild divergence means reframe. |
| F. Verify | `reverified` | The synthesis faces the same gates. A new failure sends the run back to framing or to a missed graft. Never paper over it. |

What Concilium adds over the skill is evidence. pstack's judge reads candidates. Concilium's judge reads candidates plus gate logs and the survival matrix. (M3.2, M4, M5)

### C3. Swarm: coverage and race shapes, PASS / ISSUES / BLOCKED

Swarm separates two shapes. A race runs N workers on one brief with a selection rule declared up front. Coverage splits work into slices that all must report. Concilium uses both.

- **Race.** Candidates. The selection rule is B6's lexicographic score, declared in `rubric.json` before fan-out.
- **Coverage.** Verification. One lane per gate per candidate (`typecheck@cand-2`, `adversarial-suite@cand-1`), and every lane must report. A missing lane is a gap in the report, never silently re-run.
- **Report contract.** Every worker, whether candidate, adversary, verifier, or integrator, returns a `WorkerReport` with `status ∈ {PASS, ISSUES, BLOCKED}`, the exact `headSha`, the commands it actually ran, and evidence paths. The orchestrator re-runs gates itself and never trusts a self-reported pass. A worker's self-report is an input, and a verifier's result overrides it on the same SHA. A new head SHA voids every earlier verdict for that branch. (M1.1 report schema, M4.1)

### C4. Per-role model configuration, cross-family panels

pstack configures models per role (code, judgment and prose, strongest judgment, panel pools) and keeps review panels diverse by family. Concilium config:

```yaml
# ~/.config/concilium/roles.yaml  (or .concilium/roles.yaml in the target repo)
roles:
  framer:      { runner: claude-code:opus }        # judgment: spec, rubric, reframe questions
  candidate:   [claude-code:opus, codex:default, gemini:pro]   # code
  adversary:   same-as-candidate                   # each family attacks the others
  judge:       { pool: [claude-code:opus, codex:default, gemini:pro], require: cross-family }
  integrator:  { runner: claude-code:opus }        # code + judgment
  verifier:    { pool: [codex:default, gemini:pro], require: not-author-family }
```

A config validator (M8.3) rejects a configuration that would let a family judge only itself or verify its own integration. Defaults resolve to each CLI's own default model when unset, so a stale model id cannot break a run (fixes A3.10).

### C5. Autonomy tiers

pstack's rule is "just do it" for reversible work, and always pause for irreversible writes (force-push to shared branches, deploys, data deletion, customer messages). B10 is that rule made concrete for Concilium's action set and enforced in `ActionGate`, not left to prompt text. (M7.1)

### C6. Decision trail committed with the PR

show-me-your-work keeps an append-only TSV (`ts, phase, decision, why, evidence, result`) with evidence as pointers, audits it against what actually happened, and has a different model family review the trail before hand-back. Concilium writes `decisions.tsv` from the orchestrator itself, not from agent prose. The rows are framing, rubric frozen, each dropout, each gate result summary, base pick, each graft and rejection, each revert, and the reframe decision. Because the orchestrator writes the rows from real events, the "audit the log against the transcript" step reduces to a consistency check between `decisions.tsv` and `events.jsonl`. A final cross-family reviewer reads the trail and writes the "Attention" list into `synthesis.md`. The trail is committed on the integration branch (B9). (M6.2)

### C7. Fresh agent per round with consolidated scope

pstack does not chain interrupts or resume agents. It spawns a fresh agent with consolidated scope, and every brief carries the standing orders. The orchestrate playbook's brief template (`GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, TIMEBOX, FORBIDDEN, REPORT, STANDING`) becomes Concilium's brief file format. Each round (candidate, adversary, judge, integrator, verifier) is a new CLI process with `--no-session-persistence` or the equivalent. Upstream results it depends on (the frozen rubric, peers' diffs for an adversary, the graft list for the integrator) are pasted or linked in full, because a worker cannot see its siblings. A brief with an empty required field is refused before spawn. (M1.1 brief schema, M3)

### C8. Shipping: green is not safe

pstack's Shipping playbook requires an independent per-PR verdict before landing. The verifier must not have written the code. CI green and an approving bot review do not replace it. The verdict is keyed to head SHA, base SHA, and `git patch-id`. Only the contiguous verified run from the root lands, and merges use a head-SHA guard (`gh pr merge --match-head-commit`). For Concilium:

- "Mergeable" in a run report means verified at a specific head and base, and nothing more.
- In M7, opening a PR is a paused action. Before any PR is marked ready, a verifier from a non-author family runs the gates and the adversarial suite in its own worktree at the PR head and writes `PASS`, `PASS+NOTES`, or `FAIL` with the head SHA, base SHA, and patch-id into the run store.
- A changed head voids the verdict. Merging stays a human action in layer 3.

---

## Part D. Milestones

Each milestone is one PR-sized unit that ends in a check. Order matters. Each unit proves something the next relies on (Sequence Work into Verifiable Units). Tags `[pstack:n]` point at Part C.

Verification rule for every milestone. Unit tests alone do not pass a milestone. Each milestone names a real-artifact check (a command run on a fixture repo or this repo, with its output saved to the PR).

**Fixture repos.** M0.2 creates `fixtures/` with three tiny target repos, each with its own gates and a seeded task. `ts-bug` is a TypeScript off-by-one with a vitest suite. `py-feature` is a small Python package with pytest and ruff. `ts-refactor` is a module with duplicated logic and a characterization suite. Every later milestone runs against them.

### M0. Make the base trustworthy (subtract before adding)

**M0.1 Reproducible build and CI.**
- Commit `package-lock.json` (remove it from `.gitignore`). Untrack `packages/core/tsconfig.tsbuildinfo` and `.claude/settings.local.json`.
- Add a root flat ESLint config covering `packages/*` and `desktop/`. Add `typecheck` scripts. Raise `engines.node` to `>=22`. Upgrade TypeScript behind a green typecheck.
- Add `.github/workflows/ci.yml` running `npm ci`, typecheck, lint, and test on Node 22 and 24.
- *Acceptance.* `npm ci && npm run typecheck && npm run lint && npm test` passes locally and in CI from a clean clone. The PR shows the CI run.

**M0.2 Pin current behavior.**
- Characterization tests for `ranking.ts` (`parseRankingFromText` variants, aggregate with partial rankings), `prompts.ts` (labels and anonymization), `parsers/claude-parser.ts` (recorded stream-json fixtures), `json-run-repository.ts` (round trip and `loadAll` stripping), and `ConfigService.resolve` precedence.
- Create the three fixture repos.
- *Acceptance.* At least 25 tests pass. Each test is shown to fail when the behavior it pins is mutated (one mutation per test file, recorded in the PR).

**M0.3 Subtract dead weight and fix doc drift.**
- Delete `TerminalSecretStore` and use `PlaintextSecretStore`. Delete the OpenRouter `FALLBACK_MODELS`. Delete the unused flags `--stage1-only`, `--jurors`, and `--format`, or implement `--stage1-only` only if it is wanted (open question F1). Use the custom error classes or delete them.
- Fix AGENTS.md, README.md, and `packages/cli/README.md` (no `gui` command, real test paths).
- *Acceptance.* `rg "TerminalSecretStore|FALLBACK_MODELS|stage1Only"` returns nothing. The pinned tests are still green. The docs list only commands that `concilium --help` prints.

**M0.4 One composition root and a provider registry.**
- Add `createConciliumRuntime(adapters)` in core. Use it from `cli/src/commands/run.ts`, `cli/src/index.ts`, and `desktop/src/main/ipc.ts`.
- Replace the scattered provider unions with a `PROVIDERS` registry table (id, display name, family, capabilities). Make the desktop renderer import types from core instead of `renderer/types/index.ts`.
- *Acceptance.* Adding a dummy provider to the registry in a test makes it appear in CLI validation and config validation with no other edits. `buildProviders` exists in exactly one place.

**M0.5 Fix the known defects.**
- Key Stage 1 results and snapshots by `instanceId` and keep the display name separate (A3.1). Remove the empty-id pricing match (A3.2). Pass `agent.cwd` to OpenCode, after a repro test confirms A3.3. Remove the ordered example from the ranking prompt (A3.4). Thread `AbortSignal` into `LlmGateway` (A3.6).
- *Acceptance.* A regression test per defect fails before the fix and passes after, and lands first in history [pstack:1 bug-fix]. A run with two default OpenCode agents shows two separate leaderboard rows.

### M1. Drive subscription CLIs headlessly

**M1.1 `HeadlessAgent` port, brief and report schemas, `concilium doctor`.**
- Add `ports/headless-agent.ts`, the brief file format (C7 fields), and the `WorkerReport` JSON schema (C3).
- Add `concilium doctor`, which runs each CLI's `probe()` and prints a table of CLI, version, logged in, plan (when exposed), headless flags confirmed, and sandbox modes.
- *Acceptance.* `concilium doctor` on the dev machine prints a row per installed CLI. Recorded probe outputs are committed as fixtures, and parser tests run against them. A brief missing `ACCEPTANCE` or `VERIFY` is rejected with a named-field error [pstack:7]. A report without `headSha` fails schema validation [pstack:3].

**M1.2 Claude Code adapter.**
- Port `ClaudeProvider` command building and parsing into `adapters/cli/claude-code.ts` with `access: read-only | workspace-write`. Read-only keeps today's flags.
- *Acceptance.* With `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` unset, a read-only run on `fixtures/ts-bug` returns a plan, and a write run in a temp worktree produces a commit. `git status` in the fixture's main checkout is clean afterwards.

**M1.3 Codex CLI adapter.**
- Implement `adapters/cli/codex.ts` on `codex exec --json`, then delete `resolveCodexBinaryPath` and the `@openai/codex-sdk` dependency once the plan council uses the adapter (M1.6).
- *Acceptance.* Same as M1.2 for Codex. The `read-only` sandbox blocks a write attempt in a test brief that asks for one, and the adapter reports `BLOCKED` or `ISSUES`, not `PASS`.

**M1.4 Gemini CLI adapter.**
- *Acceptance.* Same as M1.2 for Gemini. It appears in `concilium doctor`.

**M1.5 OpenCode adapter.**
- Per-worktree directory. Tool map by role.
- *Acceptance.* Same as M1.2. Two concurrent OpenCode candidates in two worktrees each modify only their own tree (checked by `git status` in both).

**M1.6 Plan council on subscriptions.**
- Implement an `LlmGateway` over read-only `HeadlessAgent` calls for jurors and the chairman. Migrate the three old providers to the CLI adapters and delete them in the same wave. OpenRouter becomes optional.
- *Acceptance.* `concilium run "<prompt>" --agents claude,codex,gemini` completes all three stages with no API keys in the environment. The pinned tests from M0.2 still pass.

### M2. Worktree workspaces

**M2.1 `WorkspaceManager` on `git worktree`.**
- Create from `baseSha`, refuse dirty trees (or snapshot with `--include-dirty`), use the `concilium/<run>/<cand>` naming, run `concilium gc`, and recover from crashes.
- *Acceptance.* A test creates 3 worktrees, kills the process mid-run, and runs `gc` twice. Both runs leave the same state (idempotent), and `git worktree list` shows none of the run's worktrees. The user checkout's `git status --porcelain` is empty throughout.

**M2.2 Candidates write code.**
- New command `concilium code "<task>" --type bug-fix --candidates claude,codex,gemini`. Each candidate gets a worktree and a brief, commits, and reports. The orchestrator records diff, commits, and head SHA.
- Measure the per-worktree install cost on each fixture.
- *Acceptance.* On `fixtures/ts-bug`, three branches exist with distinct head SHAs and a `report.json` each. The run store matches B9. Install cost per worktree is recorded in the PR. A killed candidate becomes a recorded dropout and the run continues with N-1 [pstack:2].

### M3. Framing: playbooks and rubric

**M3.1 Playbook registry and task-type routing.** [pstack:1]
- Playbook files per `TaskType`, injected verbatim into briefs. Candidates report each step done or skipped with a reason. `--type` is required at first. Auto-classification by the framer role is a later option, and the guess is shown before fan-out.
- *Acceptance.* A candidate report missing a playbook step yields `ISSUES` in the run report. Snapshot tests show each type's brief contains its steps verbatim.

**M3.2 Rubric frozen before fan-out.** [pstack:2]
- The framer role (or the user via `--rubric file`) writes 3 to 6 criteria, each tagged `gate`, `adversarial`, or `judgment`. Store `rubric.json` and its sha256 before any candidate spawns. Candidates never see it.
- *Acceptance.* The rubric's creation timestamp precedes every candidate spawn in `decisions.tsv`. Editing `rubric.json` mid-run makes the judging phase fail with a hash mismatch. A rubric with 2 or 7 criteria is rejected.

### M4. Verification-based judging

**M4.1 Gate runner and integrity checks.** [pstack:3]
- Gate detection plus `.concilium/verify.yaml`. Run each gate on base and on every candidate head as coverage lanes. Tier 0 integrity checks.
- *Acceptance.* On `fixtures/ts-bug`, a seeded candidate that deletes a failing test is disqualified with the hunk as evidence. A gate already failing on base is reported as baseline and not counted against candidates. Every `GateResult` carries the SHA it ran at.

**M4.2 Adversarial round.**
- A fresh adversary per family writes spec-tagged tests in a scratch worktree. Run each test across all candidates and base. Build `matrix.json`. Apply the validity rule (B6 Tier 2).
- *Acceptance.* On a fixture where one seeded candidate misses an edge case named in the acceptance lines, at least one valid adversarial test kills it and survives on another candidate. A test failing everywhere, base included, is quarantined, not counted.

**M4.3 Evidence-based ranking with a cross-family judge panel.** [pstack:2, pstack:4]
- Judges receive the evidence pack, are blind to authorship, and return schema-validated JSON per criterion. Lexicographic score (B6).
- *Acceptance.* The final ranking on all three fixtures is reproducible from `matrix.json`, gate results, and `judges/*.json` by a pure function (unit-tested). Removing all judges changes only the order among candidates tied on evidence. A config with a single-family panel is rejected.

### M5. Code synthesis

**M5.1 Base pick, grafts, integration, re-verify.** [pstack:2]
- Pick the base by score, then maintainability. Name up to 2 grafts per loser with source refs. A fresh integrator applies them by hand, one commit each. Re-run all gates and the valid adversarial suite. Revert regressing grafts. Emit `result.patch` and a mergeability check against the current target `HEAD`.
- *Acceptance.* On each fixture, `git apply --check result.patch` succeeds on the fixture's current `HEAD`. All gates pass on the integration head. `synthesis.md` lists base, grafts with source candidate, rejected grafts with evidence, and dropouts. A seeded graft that breaks a test is reverted automatically and appears as a rejected graft.

**M5.2 Divergence triggers reframe.** [pstack:2]
- Detect no-gate-pass, disjoint survival failures, and judge base-pick spread. End the run in `reframe-needed` with the concrete spec questions.
- *Acceptance.* A deliberately ambiguous fixture task (two valid readings of one acceptance line) ends in `reframe-needed` and names that line. No `result.patch` is written.

### M6. Dissent and decision trail

**M6.1 Dissent records.**
- Collect the B8 sources into `dissent.json` and render them at the top of `synthesis.md`. Open dissent on an acceptance line blocks the "mergeable" label.
- *Acceptance.* On a fixture where one judge prefers another base, a dissent record exists with both rationales and evidence pointers. Overruled entries all carry a reason.

**M6.2 `decisions.tsv` written by the orchestrator and committed with the change.** [pstack:6]
- show-me-your-work columns, append-only, orchestrator-written. Consistency check against `events.jsonl`. Cross-family trail review writes an "Attention" list.
- *Acceptance.* Every row's evidence path resolves. The consistency check flags a hand-inserted fake row in a test. The integration branch contains `.concilium/runs/<id>/decisions.tsv` in its last commit.

### M7. Autonomy and shipping

**M7.1 `ActionGate` and the pause list.** [pstack:5]
- Implement B10. Every git and network side effect in the orchestrator goes through it. Paused actions are written to `gates.md` with the exact command and are executed only on `concilium approve <gate-id>`.
- *Acceptance.* An integration test with a fake remote proves `push` is never executed without an approval. A static test (a lint rule or grep in CI) proves no orchestrator module calls `git push` or `gh` outside `ActionGate`.

**M7.2 Integration PR with independent verification.** [pstack:8]
- `concilium pr <run-id>` is a paused action. It opens the PR with `synthesis.md`, `dissent.json`, and the trail in the body or commit. A non-author-family verifier then re-runs gates and the adversarial suite at the PR head in its own worktree and records `PASS`, `PASS+NOTES`, or `FAIL` with head SHA, base SHA, and patch-id. Merging stays manual.
- *Acceptance.* After a new commit is pushed to the PR branch, `concilium status` shows the earlier verdict as void until re-verified. The verifier's runner family differs from every author family of the integration commits.

### M8. Factory loop

**M8.1 Spec to plan to tasks.**
- Use the existing plan council, now on subscriptions, to turn a spec into a task list with types and acceptance lines. Run one code council per task in dependency order. Each task's base is the previous task's integration head. Stack branches locally.
- *Acceptance.* A two-task spec on a fixture produces two stacked integration branches, each verified at its own head.

**M8.2 Learning ledger.**
- One row per run, role, and runner. Columns are task type, outcome (base, grafted, gate-failed, killed-by-adversary, dropout), evidence counts, and wall time. `concilium stats` shows the win rate by task type and runner. Routing suggestions appear only after a minimum sample size, and panels stay cross-family regardless.
- *Acceptance.* `concilium stats` on the fixture runs reproduces the counts in `decisions.tsv`. A suggested candidate set never drops below two families.

**M8.3 Role config validator.** [pstack:4]
- Implement the C4 rules as a validator run at startup.
- *Acceptance.* Each rule has a rejecting test case.

### M9. Desktop catch-up (after M5)

- Upgrade Electron and the lint toolchain. Render code-council run directories read-only (candidates, matrix, dissent, trail). No new orchestration in the desktop.
- *Acceptance.* The desktop opens a run directory produced by the CLI and shows the same ranking as `synthesis.md`.

### Milestone order at a glance

```
M0.1 → M0.2 → M0.3 → M0.4 → M0.5
                          ↓
M1.1 → (M1.2 | M1.3 | M1.4 | M1.5 in parallel) → M1.6
   ↓
M2.1 → M2.2 → M3.1 → M3.2 → M4.1 → M4.2 → M4.3 → M5.1 → M5.2 → M6.1 → M6.2
                                                                    ↓
                                                          M7.1 → M7.2 → M8.1 → M8.2 → M8.3
M9 can start any time after M5.1.
```

---

## Part E. Risks

| Risk | Where it lands | Mitigation |
|---|---|---|
| **Subscription terms.** Automated, multi-process use of consumer subscriptions may conflict with a provider's terms or fair-use limits, and terms differ between providers and change. | M1 | Read each provider's current terms before M1.2 ships (F3). Keep runs user-initiated and local, under the user's own login. Keep API-key adapters available as the fallback. Do not market the project as a way to avoid API billing. |
| **Quota exhaustion.** N candidates, N adversaries, and a judge panel multiply usage within rolling windows. | M2.2, M4.2 | Per-CLI concurrency caps. `BLOCKED` with retry-after on rate limits. A dry-run cost estimate (number of processes per role) printed before fan-out. |
| **CLI output churn.** Headless JSON event formats change between CLI versions. | M1 | Probe at startup. Pinned fixture recordings per CLI version. Unknown events are kept raw and never crash the run. |
| **Running untrusted code.** Candidates and adversaries write code and tests that the orchestrator then executes. A test can delete files, read secrets, or call the network. | M4 | Run gates inside a sandbox. Use bubblewrap or a container on Linux, and a container on macOS. Network is off, the worktree is the only writable mount, and the environment is scrubbed. Ship sandbox-off only behind an explicit flag. |
| **Prompt injection from the target repo.** READMEs, comments, or issues tell an agent to exfiltrate or to weaken tests. | M1, M4 | No credentials in agent environments. Integrity checks catch weakened tests regardless of why. Gates and scoring are deterministic code, not agent claims. |
| **Gaming the evidence.** Candidates write tests that always pass, special-case adversarial inputs, or edit gate config. | M4.1, M4.2 | Tier 0 integrity checks. Authors' own tests carry no weight. The validity rule requires a test to fail on base. Gate config is in the forbid scope by default. |
| **Invalid adversarial tests.** Adversaries encode behavior the spec never asked for. | M4.2 | Every test names a `specClause`. Tests failing everywhere are quarantined for judges. Disputed tests become dissent, not hidden penalties. |
| **Flaky gates mislead ranking.** | M4.1 | Run each failing gate twice. A pass-then-fail is marked flaky and excluded from scoring, with a dissent record. Baseline on base SHA. |
| **Worktree cost.** Installs per worktree are slow and disk-heavy, especially for large monorepos (SCANOSS scale). | M2.2 | Measure in M2.2. Use shared package stores. Cap candidates by measured cost. Clean up aggressively with `gc`. |
| **Judge bias toward its own family.** | M4.3 | Blind diffs. Cross-family requirement enforced in config. Evidence dominates the score lexicographically. |
| **Scope creep into a general agent framework.** | All | Each milestone ships one verifiable unit against the fixtures. Desktop work stays frozen until M5. |

---

## Part F. Open questions

1. **Keep the plan council as a product surface?** Layer 3 reuses it as the factory's planning step. Should `concilium run` (plan-only) stay user-facing, and should `--stage1-only` be implemented or deleted?
2. **Package boundary.** Build layer 3 inside `@concilium/core` (`domain/code-council/`) as proposed, or as a new `@concilium/factory` package that depends on core? The proposal keeps one domain package until a second consumer exists.
3. **Subscription terms.** What do the current terms of Anthropic, OpenAI, and Google allow for scripted, local, multi-process use of consumer CLI subscriptions? This needs a primary-source check before M1.2 ships. The same question applies to SCANOSS business plans.
4. **Sandbox technology.** bubblewrap, rootless Podman, devcontainers, or each CLI's own sandbox only? This affects macOS support and SCANOSS adoption.
5. **Target languages for v1.** Gate detection for TypeScript and Python first? SCANOSS work is heavily Go, Python, and C, so is Go required before internal use?
6. **Commit the trail by default?** Committing `.concilium/runs/<id>/` on the integration branch is auditable, but it adds files to the user's history. Should this be opt-in or opt-out?
7. **Human ranking in the ledger.** The desktop already collects user rankings (`run:saveUserFeedback`). Should human preference be a ledger input next to evidence, or kept separate?
8. **SCANOSS-specific gate.** Should a provenance gate (scanning the synthesized diff for open-source snippet matches and licenses with SCANOSS tooling) be a standard gate when used internally? It fits the evidence model and is a natural differentiator for the open-source release too.
9. **Naming.** Are "layer 1, 2, 3" the project's terms or this document's? (See the top.)
10. **Website and Cloud waitlist.** `website/` advertises Concilium Cloud. Does layer 3 change that positioning (local subscriptions instead of hosted API keys)? Out of scope here, but the messaging will diverge.

---

## Appendix A. What this audit verified

Verified by reading code. Everything cited in Part A, from the files listed with their paths. Line numbers come from this branch at commit `76ed252`.

Verified by repository search:
- There are no `*.test.ts`, `*.test.tsx`, `*.spec.ts`, or `*.spec.tsx` files.
- There is no `.github/` directory.
- `package-lock.json` is gitignored.
- There is no `gui` command registration in `packages/cli/bin/concilium.ts`.
- No module outside `shared/errors.ts` and the index re-exports references the custom error classes.

Not verified, because the commands needed approval in this session and were not run:
- `tsc --noEmit` and `vitest run` for any package. The current typecheck and test state is unknown. M0.1 establishes it.
- The installed versions and headless flags of `claude`, `codex`, `gemini`, and `opencode`. Every CLI invocation in B5 is a starting point to be confirmed by the M1.1 probe.
- Finding A3.3 (OpenCode ignoring `cwd`) is inferred from the code. A repro test in M0.5 must confirm it before the fix.
- The Electron and TypeScript currency claims in A7 are estimates from release cadence, not checked against the registries.

---

## See also: M10 and later

[factory-architecture.md](./factory-architecture.md) continues this plan after M7. It covers the control plane (`concilium serve`), the runner protocol shared by local and cloud runners, the PWA and other API clients, subscription auth on remote runners, org mode, and the per-repo `factory.yaml`. Its milestones M10 to M14 run in four gated phases: core plus local runner, API plus PWA, cloud runners, SSO and orgs.

Two changes it makes to this plan:

- `.concilium/verify.yaml` (B6) and `roles.yaml` (C4) become the `checks:` and `roles:` sections of `.concilium/factory.yaml` (M10.2).
- M9 (desktop catch-up) is replaced by M11.6: Electron becomes a client of the factory API.
