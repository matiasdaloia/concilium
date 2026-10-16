# Software factory landscape — Oct 2026

Read-only research, 16 Oct 2026. Sources: public X posts (read through the X API) and web pages I actually opened or saw in search results. Each claim below comes from the source next to it. Some X posts include images or videos I did not watch, so I describe only their text.

## 1. Concrete setups

### 1. OpenAI Symphony (open-source spec + Elixir reference impl)
- Sources: https://openai.com/index/open-source-codex-orchestration-symphony/ (27 Apr 2026, Kotliarskyi, Zhu, Brock). Users on X: https://x.com/daniel_mac8/status/2048845594756522365 (30 Linear issues in a week on a ChatGPT sub, "VERY token hungry"), https://x.com/chaz/status/2090810647948730466 (running for months on hundreds of PRs).
- **Tracker:** Linear is the control plane, and its ticket statuses act as the state machine. The spec defines the tracker adapter so other trackers can be swapped in.
- **Trigger:** Symphony polls the tracker (`polling.interval_ms`, default 30s). Every issue in an `active_states` status gets its own agent. People file tickets from anywhere, including the Linear phone app.
- **Stages:** these come from the repo's `WORKFLOW.md`, written in prose: plan ticket → task DAG (dispatch skips `blocked_by` issues) → implement → PR → Human Review → Merging. In the Merging stage the agent watches CI, rebases, resolves conflicts and retries flaky checks. Agents can file follow-up issues on their own.
- **Human gates:** a configurable handoff state such as `Human Review`. A successful run does not mean Done.
- **Runtime:** `codex app-server`, a headless JSON-RPC agent over stdio. The command is configurable.
- **Sandbox:** one deterministic workspace directory per issue, plus lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`). Safety invariants: cwd must equal the workspace, and the workspace must sit inside the root. Agents can also run on remote hosts over SSH (`worker.ssh_hosts`).
- **Verification:** handled inside the agent harness: e2e tests, Chrome DevTools and QA smoke tests. The "review packet" includes a video walkthrough.
- **Observability/cost:** structured logs, plus token totals and rate limits per session and in aggregate. An optional HTTP status server is available.
- **Configurable:** YAML front matter in `WORKFLOW.md`, hot-reloaded: tracker kind/project/active and terminal states, polling, workspace root, hooks + timeout, `max_concurrent_agents`, `max_concurrent_agents_by_state`, `max_turns`, retry backoff, Codex approval and sandbox policy, turn/stall timeouts. The prompt template is strict Liquid.
- **Notable choice:** the Linear token never reaches the agent. A `linear_graphql` dynamic tool is exposed instead. The authors also say "give agents objectives, not rigid state transitions."

### 2. Vercel Labs "Foreman" (eve-software-factory-template, MIT)
- Sources: https://github.com/vercel-labs/eve-software-factory-template (README) and the X thread https://x.com/Granite0x/status/2087960767287230592
- **Tracker:** GitHub Issues and Linear (Linear Agent Sessions).
- **Triggers:** an issue labeled `factory` (`FACTORY_LABEL`), an @mention on an issue or PR, delegation in Linear, a local dev TUI where GitHub writes need approval, red CI on a factory PR (it fixes only its own branches), and a new PR, where it posts one orienting comment.
- **Stages, called four stations:** Classifier (type, priority, complexity; asks the requester when the task isn't actionable) → Analyst (plan + acceptance criteria) → Implementer (in its own sandbox, runs the repo's own checks, pushes a branch) → Reviewer (judges the real diff with evidence; per the X post it can send work back twice).
- **Independence:** the Reviewer sees only the pushed branch, never the Implementer's reasoning. The X post says it runs on a different model vendor.
- **Human gate:** the factory delivers a draft PR. A human marks it ready and merges.
- **Memory:** a "factory brain" of per-repo notes. Per the X post, issue text can't write into it, which guards against prompt injection.

### 3. StrongDM Software Factory / Attractor ("dark factory")
- Sources: https://factory.strongdm.ai/ , https://simonwillison.net/2026/Feb/7/software-factory/ , https://github.com/strongdm/attractor (search results).
- **Rules:** "Code must not be written by humans / must not be reviewed by humans." Humans write the spec, the scenarios and the constraints.
- **Verification:** end-to-end "scenarios" kept as a holdout set, scored as "satisfaction", meaning the fraction of trajectories that satisfy the user. A Digital Twin Universe clones third-party services (Okta, Jira, Slack, Google Docs/Drive/Sheets) so tests can run at high volume.
- **Pipeline engine:** Attractor is a natural-language spec, not code. Pipelines are DOT graphs whose nodes can be LLM tasks, human reviews, conditionals or parallel fan-outs, with checkpoints and retries. The backend is pluggable and can spawn Claude Code, Codex or Gemini CLI as subprocesses.
- **Cost heuristic:** "$1,000 in tokens/day per human engineer."

### 4. Matt Pocock: day shift / night shift, Sandcastle
- Sources: https://x.com/mattpocockuk/status/2048159313357598989 and https://github.com/mattpocock/sandcastle (README). The `mattpocock/software-factory` README returned 404, so that repo is not public or does not exist.
- **Tracker:** tickets, which the post calls a PRD ticket plus implementation tickets.
- **Day shift (human):** `/grill-me` to align → `/to-prd` + `/to-issues`, which produce a PRD and parallelizable tickets → QA of the branches → follow-up issues and edits to the PRD.
- **Night shift (AFK):** a planner agent finds unblocked tickets → launches parallel implementers in sandboxes → one reviewer agent per implementation checks alignment with the PRD and code quality → branches become PRs → the planner loops until the work is done.
- **Sandbox (Sandcastle):** `sandcastle.run()` with pluggable providers: Docker, Podman, Vercel Firecracker microVMs, no-sandbox, or custom. It has a branch strategy and worktree support, and uses the Claude Code OAuth token (`claude setup-token`), so it runs on a subscription rather than an API key.
- **Lessons:** unbounded overnight runs produce bad code, and review is "crucial".

### 5. Ben Holmes's team (two posts)
- Sources: https://x.com/BHolmesDev/status/2106510336413012463 , https://x.com/BHolmesDev/status/2107962128883941684 . A related essay is linked from https://x.com/BHolmesDev/status/2110793920930107817 but I did not read it.
- **Intake:** mostly Slack threads, sometimes Linear issues. They are trying GitHub Issues as a backlog for secondary bugs.
- **Stages:** a triage agent researches and decides whether to implement or ask questions → implementation agent, optionally co-writing a spec with a subagent → verification subagent runs e2e tests → a code-review agent cycles with the implementer for a few rounds → a human reviews and ships → a monitoring automation responds to alerts and files issues ("closing the loop").
- **iOS variant:** a "foreman" agent coordinates an implementer on a macOS cloud machine (simulator screenshots and recordings) and a reviewer on Linux. Each runs in its own Docker container and they talk through a message-passing service. Users can skip the review step while prototyping.
- **Open question they raise:** whether separate triage and implementation agents beat one strong model.

### 6. Runlayer (Rafal Wilinski)
- Source: https://x.com/rafalwilinski/status/2109940991868252302
- **Signals:** customer calls (Fireflies), customer Slack channels, red CI on main, Slack @mentions and DMs, and UI pins on prod (agentation.com), where a webhook carries the element, page and note.
- **Dedup:** every request is checked against Linear and open PRs. Duplicates add the customer as one more voice on the existing issue.
- **Routing:** small, clear work gets built right away. Big changes, or anything touching auth or the hot path, go to engineers as a write-up or draft PR.
- **Build:** a sandboxed agent clones the repo, reproduces the bug, fixes it, runs tests, and opens a PR with before/after screenshots or a recorded demo → an adversarial review agent checks it → small, low-risk changes are auto-approved and auto-merged. A babysitting agent answers comments, "argues with what isn't" real, and fixes red CI and conflicts.
- **After merge:** a QA fuzzing agent hits prod, and the stakeholders who asked (FDEs, sales, customers) get DMs. The changelog is an append-only ledger of md files. The post reports 91 PRs merged by one agent in 24 hours.

### 7. Mainframe (Vincent van der Meulen): orchestrator-of-agents via Linear
- Source: https://x.com/vinvan/status/2072718922843816126 . Companion piece: https://x.com/vinvan/status/2081807325526958552 ("cloud agents ready" codebases; I read only the post text).
- **Flow:** a dictated ~10K-word todo list → Claude ("fable") plans locally into Linear as a DAG built for maximum parallelism, fanning out to Codex subagents → a Devin cloud "middle manager" agent dispatches subagents per issue → Linear and Slack MCPs keep the board updated, and the manager tags coworkers when it has questions and posts heartbeats.
- **Burden of proof:** a self-review, a green Cursor bug bot, clean bot fixes, and a recording. iOS e2e runs through limrun.
- **Result:** 60+ PRs in one night. The new bottleneck is review.
- **Tips:** attach the manager prompt as a file so it is never compacted, and keep the manager's context window "holy" by delegating everything.

### 8. Cursor Automations (product; config-surface reference)
- Sources: https://cursor.com/docs/cloud-agent/automations , https://cursor.com/help/ai-features/automations , https://cursor.com/blog/automations (search results). X: https://x.com/aakashgupta/status/2029791518844969272
- **Trigger catalog:** cron; draft opened / PR opened / PR pushed / PR merged / push to branch; PR commented; GitHub CI completed; Slack new message (keyword/regex filters), reaction, channel created; Linear issue created / status changed / end of cycle; PagerDuty triggered/acknowledged/resolved; generic webhook (HTTP POST). One automation can have several triggers.
- **Repo scope:** none, single, or multi-repo. Agents run in cloud VM sandboxes with configurable models and MCPs, plus a memory tool that learns across runs.
- **Example recipes:** a PagerDuty incident → Datadog MCP investigation → Slack message + fix PR. A Slack bug report → dedup → Linear issue → root cause → fix → thread reply.

### 9. Ramp Inspect
- Sources: https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal , https://builders.ramp.com/post/why-we-built-our-background-agent , https://newsletter.pragmaticengineer.com/p/why-ramp-built-inspect (search results).
- **Runtime:** OpenCode, chosen for its HTTP API and model agnosticism, running in Modal sandbox VMs with the full stack (Postgres, Redis, Temporal, Vite), plus VS Code server, a web terminal, and VNC + Chromium for visual checks.
- **Startup:** a cron rebuilds repo snapshots every 30 minutes, so sessions start in seconds. Cloudflare Durable Objects hold per-session state.
- **Clients:** Slack bot, web app, Chrome extension.
- **Integrations:** Sentry, Datadog, LaunchDarkly, Braintrust, GitHub, Buildkite.
- **Adoption:** Pragmatic Engineer reports 75% of merged PRs; the Modal post says over half.

### 10. Uber Software Factory (enterprise reference)
- Sources: https://www.uber.com/us/en/blog/efficient-software-factory/ (27 Aug 2026), https://ai.engineer/talks/17-YSUHo6Lk-agentic-sdlc-at-uber-building-blocks-ubers (search results).
- **Adoption:** over 70% of PRs come from local or cloud agents.
- **Managed agents:** code review, CI self-healing, e2e PRs with visual validation, on-call alert triage, bug debugging, migrations (250+, 9M LOC).
- **Platform:** model gateway, MCP gateway (a single discover-and-call tool, compact responses, >40% fewer tokens), skills marketplace, context graph.
- **Minion flow:** Slack idea → draft PR that stops before CI; the inner loop validates simulator screenshots against Figma.
- **Cost:** spend has been flat since April while usage grew 7x. They credit specialized managed agents, each with its own eval benchmark and a "Pareto-efficient model".

### Smaller data points
- Gokul Rajaram (https://x.com/gokulr/status/2032271386161684665): anyone at the company invokes the factory from Slack or phone; agents spec, PR, review and merge "with the right human approvals based on the repo". Quotes Podium CEO Eric Rea: Slack tag → fix in 15 minutes.
- Dex Horthy, "Why Software Factories Fail", parts 1 and 2 (https://x.com/dexhorthy/status/2080697380379427275 , https://x.com/dexhorthy/status/2081058573556306030). These are X articles I did not read; one reply says Horthy argues "for now, read the dang code".
- Composio Agent Orchestrator, open source, for running ~30 agents across issues; the claim is from a third-party post: https://x.com/eng_khairallah1/status/2036156107412869236
- Kush (https://x.com/kushbhuwalka/status/2057191555589628362): an "AI employee" running Codex on Daytona, with tools (Linear/GitHub/Slack/Vercel/Notion) permissioned through "executor".

## 2. Common patterns
1. **The tracker is the control plane.** Linear dominates, then GitHub Issues; small teams go Slack-first. Ticket status or a label acts as the trigger, and the board doubles as the state machine and audit trail (Symphony, Foreman, Mainframe, Pocock).
2. **Many intake channels, one queue.** Slack mentions and threads, labels, @mentions on PRs, red CI, alerts (PagerDuty/Sentry/monitors), customer calls, UI pins via webhook, cron. New requests are **deduplicated against the tracker and open PRs** before work starts (Runlayer, Cursor recipe).
3. **A triage/classify gate that can ask questions.** Every serious setup has a station that decides between implementing and asking (Foreman Classifier, Holmes triage, Pocock `/grill-me`). Vague issues produce questions, not code.
4. **Spec/plan with acceptance criteria, then a DAG.** Plans become dependency-aware tickets, and only unblocked ones are dispatched in parallel (Symphony `blocked_by`, Pocock planner, Mainframe).
5. **Separate implementer and reviewer, ideally across vendors and context-isolated.** The reviewer sees only the branch (Foreman). Review is adversarial and runs a bounded number of loops (2 in Foreman, "a few rounds" for Holmes).
6. **Evidence or it didn't happen.** The repo's own checks, e2e runs, screenshots and video walkthroughs travel with the PR. StrongDM goes further with holdout scenarios and service twins.
7. **Risk-tiered autonomy.** Small, low-risk work auto-merges. Auth, the hot path and large changes become a draft PR or write-up. Most teams stop at a draft PR and a human merge. The dark-factory extreme drops human review and relies on validation instead.
8. **PR babysitting is its own agent.** It responds to review comments, fixes red CI, rebases and resolves conflicts (Symphony Merging, Runlayer, Foreman).
9. **One workspace per task**, as a worktree/directory, a container (Docker/Podman) or a microVM/VM (Firecracker, Modal), often prewarmed from snapshots (Ramp).
10. **Policy as versioned files in the repo:** `WORKFLOW.md`, skills, AGENTS.md. Failures get fixed by adding guardrails or skills, not by patching output by hand (Symphony).
11. **Durable memory, kept away from untrusted input:** Foreman's factory brain, Cursor's memory tool. Secrets are never handed to agents (Symphony's `linear_graphql` tool).
12. **Closing the loop:** monitoring and alerts file issues, QA fuzzes prod after merge, stakeholders get notified, the changelog is a ledger.
13. **The bottleneck moves to review and intent.** 60+ PRs a night (Mainframe); Uber says the hard part is now deciding *what* to build.
14. **Cost is the visible downside** ("VERY token hungry", the $1k/day heuristic). Big shops add per-agent model routing and evals (Uber).

## 3. Proposed configuration surface for the Concilium factory
The proposal follows Symphony's model: one versioned `factory.yaml` (or `WORKFLOW.md` front matter) per repo, hot-reloaded, plus a user-level file for accounts and secrets. Every section below is meant to be configurable.

### 3.1 Triggers / event sources
- `github`: issue opened/labeled (label, e.g. `factory`), issue/PR comment with a `@concilium` mention (allowed authors: owner/member/collaborator), PR opened (orientation comment only), PR review comments, check_suite failed (only on factory branches, or also main?), push to main.
- `linear`: issue created, status → X, delegated to agent (Agent Sessions), end of cycle.
- `jira` / `gitlab`: same event shapes through adapters.
- `slack`: app mention, DM, messages in a channel with keyword/regex filters, emoji reaction (e.g. :factory:).
- `alerts`: Sentry new issue/regression, PagerDuty incident, Datadog monitor.
- `webhook`: generic HTTP POST endpoint with a schema mapping (for UI pins, forms, customer-call tools).
- `cron`: scheduled jobs (dependency bumps, flaky-test sweeps, doc drift, backlog grooming).
- `chat/cli/tui/mcp`: interactive intake ("plan a feature with me"), and a call from another agent through the MCP server.
- Per source: `enabled`, filters, allowed actors, rate limit, `dedupe: true`.

### 3.2 Trackers
- `tracker.kind`: github | linear | jira | gitlab | local (markdown/SQLite for solo use).
- State mapping: `active_states`, `handoff_states` (Human Review), `terminal_states`, blocked-by relation.
- Write policy: whether the factory may comment, transition status, create follow-up issues, or link PRs.
- Dedupe policy: match against open issues and PRs (embedding or title), merge as a "+1 voice".

### 3.3 Routing rules → playbooks
- A classifier output schema: `type` (bug | feature | refactor | perf | security | chore | investigation | docs), `risk`, `size`, `actionable`, `touches` (paths).
- An ordered list of rules: `when` (type/labels/paths/source/size) → `playbook` (bugfix, feature, refactor, perf, arena, swarm, investigate-only, ask-questions).
- Path-based risk: e.g. `auth/**`, `billing/**`, migrations → `risk: high` (forces arena + human gate).
- Spec gate: which types need an approved spec before implementation.
- Divergence rule: if arena candidates diverge more than a threshold, reformulate the spec rather than average them (pstack).

### 3.4 Agent / model roster per role
- Runtimes: claude-code, codex (app-server), gemini-cli, opencode, cursor-agent, amp, each with `auth: subscription | api_key` and a command.
- Roles: triager, spec-writer, planner, implementer(s), adversarial-test-writer, reviewer/judge, integrator/grafter, pr-babysitter, verifier.
- Constraints: `judge.family != implementer.family`, and the reviewer gets context isolation (diff only).
- Fallbacks when a subscription is rate-limited, and per-role reasoning effort.
- Learned routing: a leaderboard by (repo, task type, model) chooses the panel; it can be turned on or off.

### 3.5 Panel size and verification policy
- `panel.size` per playbook (1 for trivial, 2–4 for arena), `max_review_rounds` (e.g. 2), and a rubric (3–6 criteria written before the candidates run).
- Required checks: build, typecheck, lint, unit tests, e2e, benchmarks, adversarial tests written by peers, screenshot/video for UI changes, holdout scenarios.
- Scoring: which signals matter and how much (passes, test breaks, diff size, maintainability judge score).
- Synthesis: pick the base branch plus graft at most N ideas, then re-verify.
- Evidence format: PASS | ISSUES | BLOCKED, with SHAs and logs attached to the PR.

### 3.6 Autonomy gates
- Tiers per action: auto | notify | approve. Actions: create branch, push branch, open draft PR, mark ready, merge, deploy, comment on tracker, create issues, message humans.
- Per-repo or per-path overrides, e.g. auto-merge allowed only for `risk: low` + `size: s` + all checks green + an independent verifier pass.
- Never-auto list: push to main, force-push, deletions, secrets, infra.
- Escalation: when input is required, either ask on the origin channel or fail the run (configurable).
- Human gate points: spec approval, plan approval, final merge.

### 3.7 Sandbox
- `sandbox.kind`: worktree | docker | podman | microvm/remote (SSH hosts, Vercel/Modal/Daytona).
- Workspace root, reuse policy, cleanup on terminal state, prewarmed snapshots (Ramp-style cron).
- Hooks: after_create, before_run, after_run, before_remove, plus timeouts.
- Network policy (allowlist), mounted credentials (scoped tokens only; tracker access through a proxy tool, not a raw token), resource limits.

### 3.8 Budgets / limits
- `max_concurrent_agents`, global and per state, per runtime/subscription, per host.
- Per run: max turns, turn timeout, stall timeout, retry backoff, max retries.
- Per task, day or month: token/$ caps, and subscription-quota awareness (pause when near the weekly limit).
- Wall-clock limit per playbook, and an "abandon and report" threshold.

### 3.9 Notifications
- Channels: Slack (origin thread first), GitHub/Linear comments, email, desktop/phone push.
- Events: started, question, blocked, PR ready, merged, failed, budget threshold, heartbeat interval.
- Stakeholder fan-out: notify the requester and anyone who +1'd the issue when the change ships. Changelog ledger entry.

### 3.10 Storage / memory / observability
- Run store: SQLite locally (runs, attempts, events, tokens, verdicts, evidence artifacts).
- Artifacts: logs, screenshots, videos, test reports (local dir or S3/blob).
- Factory memory per repo: notes and quirks, writable only by trusted stages, never directly from issue text.
- Decision log: the decision record attached to each PR.
- Leaderboard: model × task type × repo outcomes.
- Telemetry: structured logs, OTel traces, a status dashboard/TUI, cost reports.
