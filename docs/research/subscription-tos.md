# Subscription CLIs: terms of use and integration prior art

Researched 2026-10-16 for M1 (subscription CLI adapters). Only URLs that were actually fetched are cited. This is not legal advice; re-check before any distribution beyond personal use.

Intended use: one person runs Concilium on their own machine, which spawns the *unmodified* official CLIs (Claude Code, Codex, Gemini CLI, OpenCode) headlessly, several in parallel, each signed in with that person's own subscription. Concilium never collects, stores, or proxies credentials.

## Terms of use

| Provider | What the terms say | Verdict for intended use |
|---|---|---|
| **Claude Code** (Pro/Max OAuth, `setup-token`) | Source: https://code.claude.com/docs/en/legal-and-compliance. Pro/Max fall under the Consumer Terms. "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." Subscription OAuth is "designed to support ordinary use of Claude Code and other native Anthropic applications". Third-party developers may not "offer Claude.ai login into their own applications, or … route requests through Free, Pro, or Max plan credentials on behalf of their users", and may not "collect, store, or intermediate Claude.ai credentials". It explicitly does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". | **Allowed with ambiguity → proceed (personal use).** Spawning the unmodified `claude` binary, which uses the user's own login, fits. Heavy parallel automation may exceed "ordinary, individual usage". Rules: never read, store, or forward the OAuth token; never ship Claude login inside Concilium; no shared or hosted accounts serving others. |
| **Codex CLI** (Sign in with ChatGPT) | Source: https://developers.openai.com/codex/auth. ChatGPT sign-in is supported for local CLI work and uses plan credits. "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs." Copying `~/.codex/auth.json` to headless machines and trusted CI runners is documented, with "API keys are still the recommended default for automation". Enterprise has "Codex access tokens" for non-interactive use. | **Allowed for personal local use → proceed.** Automation on ChatGPT login is documented (but discouraged in favour of API keys), not forbidden. Note the recommendation; for CI or cloud runners prefer an API key or access token. |
| **Gemini CLI** (Google account / Code Assist / AI Pro-Ultra) | Source: https://geminicli.com/docs/resources/tos-privacy/ (and https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md). The CLI is Apache-2.0. Use is governed by the terms of the account type: Google ToS plus the Code Assist privacy notice (individuals), Google One terms (AI Pro/Ultra), GCP terms (Standard/Enterprise), Gemini API terms (API key). Usage statistics (prompts and code) may be collected by default for some auth types, with an opt-out. | **No prohibition found → proceed.** Recommend the user opts out of usage statistics, or uses an API key or Vertex for private code. Quotas per account apply. |
| **OpenCode** | OpenCode is an open-source agent. Its terms depend on the model provider configured inside it. The Claude Code terms above forbid third-party apps from using Claude.ai subscription login, so running OpenCode on a Claude Pro/Max login is not covered. | **Proceed with OpenCode's own provider keys or models** (API keys, OpenCode-hosted or local models). Do not route a Claude subscription through OpenCode. Use the Claude Code adapter for Claude. |

**No provider clearly forbids personal, automated, parallel runs of its own CLI on the user's own machine.** Proceed with M1 for personal use. Product guardrails that follow:
1. Spawn only official, unmodified binaries. Never read or copy their credential files.
2. One user's subscriptions serve only that user's work items (already a rule in factory-architecture.md).
3. `concilium doctor` shows which auth each CLI uses and links to this doc.
4. Default concurrency per subscription is conservative (e.g. 2), and the planner backs off on rate-limit signals.
5. For CI, cloud runners and org mode, document API-key mode as the recommended path.

## How existing apps drive subscriptions

Code read 2026-10-16 from shallow clones of https://github.com/pingdotgg/t3code, https://github.com/stablyai/orca and https://github.com/BloopAI/vibe-kanban. ACP agent list: https://agentclientprotocol.com/overview/agents.

| App | Claude Code | Codex | Gemini CLI | OpenCode | Other |
|---|---|---|---|---|---|
| **T3 Code** | `@anthropic-ai/claude-agent-sdk` (`apps/server/src/provider/ClaudeProvider.ts`, `ClaudeAdapterV2.ts`) | own `effect-codex-app-server` package (JSON-RPC `codex app-server`) | via generic ACP provider (`packages/provider-acp`, `provider-acp-registry`) | `packages/provider-opencode` | worktree handoff via an MCP service (`WorktreeMcpService.ts`) |
| **Orca** ("run any coding agent with your own subscription") | Agent SDK (`claude-agent-sdk` 0.3.284) **and** a direct `claude` stream-json connection (`claude-stream-json-connection`, `pathToClaudeCodeExecutable`); multi-account via env incl. `CLAUDE_CODE_OAUTH_TOKEN` (`claude-accounts/environment.ts`) | `codex app-server` (`src/main/codex/*app-server*`) | ACP (`src/main/acp/*`, dialects per agent) | ACP | usage and rate tracking per provider (`claude-usage`, `codex-usage`), workspace trust guards before spawn |
| **Vibe Kanban** | spawns `claude` with `--output-format=stream-json --input-format=stream-json` (`crates/executors/src/executors/claude.rs`) | `codex app-server` via `codex_app_server_protocol` (`codex.rs`) | `gemini --experimental-acp` with a shared ACP harness (`gemini.rs`, `acp/`) | starts `opencode serve` and talks HTTP (`opencode.rs`) | git worktree per task |

Patterns:
- **Auth:** every app reuses the CLI's own stored login. None implements OAuth itself. Orca also supports `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) for multiple accounts. This matches the Anthropic rule (unmodified binary, the user's own sign-in).
- **Transport:** no single protocol covers all four. In practice:
  - Claude: Agent SDK or `claude -p --output-format stream-json`.
  - Codex: `codex app-server` (JSON-RPC) for rich sessions, or `codex exec --json` for one-shot runs.
  - Gemini and OpenCode (and many others): ACP over stdio.
  - Claude and Codex are also reachable over ACP, but only through adapters (Zed's Claude adapter, ACP's Codex adapter).
- **Sessions/resume:** handled natively per CLI (Claude `--resume <session_id>`, Codex threads, ACP `session/load`).
- **Permissions:** apps either pre-set a permission policy (allowed tools, sandbox mode) or answer approval requests interactively (ACP `session/request_permission`, Codex app-server approvals).
- **Concurrency and rate limits:** orca tracks usage per account. Rate limiting is detected from the CLI's error events or exit text, and apps back off.
- **Worktrees:** git worktree per task or thread is the norm (vibe-kanban, t3code, orca).

## Implication for the M1.1 driver interface (simplest proven shape)

A council run is one-shot and non-interactive (brief in, report out), so session and approval machinery isn't needed yet:
- `HeadlessCliDriver { id, detect(): {installed, version, auth}, run(brief, {cwd, model, timeoutMs, signal}): AsyncIterable<NormalizedEvent> → Report }`.
- One small native driver per CLI, using each CLI's documented headless mode:
  - `claude -p --output-format stream-json` (permission mode and allowed tools set per brief)
  - `codex exec --json` (sandbox set per brief)
  - `gemini -p` (headless, JSON output)
  - `opencode run --format json`
- Normalize to a few events (text, tool, usage, error/rate_limit, done).
- **Keep ACP as the planned uniform path** if Concilium later needs multi-turn sessions or interactive approvals: Gemini, OpenCode and Codex (adapter) speak ACP, and so does Claude through Zed's adapter. Don't adopt the Claude Agent SDK as the core abstraction (it is Claude-only, and its docs direct product builders to API keys).

### Addendum: Crystal and opcode (read 2026-10-16)

- **Crystal (now Nimbalyst)**, https://github.com/stravu/crystal: spawns `claude --verbose --output-format stream-json` per session (`main/src/services/panels/claude/claudeCodeManager.ts`), parses Codex JSON output the same way (`panels/codex/codexManager.ts`), and gives each session its own git worktree.
- **opcode (formerly Claudia)**, https://github.com/winfunc/opcode: a Tauri app that spawns `claude ... --output-format stream-json` (`src-tauri/src/commands/claude.rs`, `web_server.rs`).
- **Conductor**: closed source, so its code was not inspected.

These confirm the M1 choice: every app here relies on the CLI's own login plus its headless JSON stream.
