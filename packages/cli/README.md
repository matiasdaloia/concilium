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

Agent CLIs (candidates, adversaries, the integrator, and every other agent run) start without push credentials: `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN`, `BITBUCKET_TOKEN`, `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_AUTH_SOCK`, `GIT_SSH` and `GIT_SSH_COMMAND` are removed, git's credential helpers are reset to none at command scope (`GIT_CONFIG_COUNT`, which beats every config file), and git's prompts are off (`GIT_TERMINAL_PROMPT=0`). Their own CLI logins are untouched. This is not a sandbox: an agent can still pass its own `git -c credential.helper=...`, read a stored credential file such as `~/.git-credentials`, or use an ssh key on disk without a passphrase. Concilium itself never pushes without your approval (see [`concilium gates`](#concilium-gates)).

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

Before synthesis, Concilium checks whether the candidates diverge, because divergence means the task can be read more than one way and a blend would hide that. It looks only at candidates that are neither blocked nor disqualified, and only when there are at least 2 of them: none of them passes the gates (each has a new gate failure); or, among those that pass the gates, each fails at least one adversarial test written by another family that fails on the base and passes on some candidate (`evidence`, `own-family-only` or `regression-guard`), and no two fail the same test, so none dominates; or judges of the same tie pick different bases (today one judge runs per tie, so this one cannot fire yet). When the only divergence is complementary misses (the second case), the candidates may each have covered a line the others missed, so synthesis runs first: the winner is the base, grafts come from the others, and each graft is re-verified with the gates and the conflicting tests too. Then the conflicting tests run again at the integration head. If that head passes the gates and every conflicting test, the run finishes normally with `result.patch`, and `synthesis.md` and `synthesis.divergence` say the divergence was resolved by grafting. If not, the run ends in `reframe-needed`: no `result.patch` is kept, the integration branch stays for inspection, and `synthesis.md`, `reframe.md`, `synthesis.divergence` and `reframe.grafting` say what grafting tried and what still fails. For the other two cases the run ends in `reframe-needed` at once: nothing is grafted, no integration branch is made and no `result.patch` is written. On `reframe-needed`, one read-only run of the first agent's CLI (the one that framed the rubric) turns each line in conflict (the `specClause` the split tests quote, or the gate no one passes) into a question for you; every line it leaves out, or all of them when it gives no usable answer, gets a question written from the evidence. The divergence, the lines in conflict with what each candidate did, and the questions go to `reframe.md` next to `run.json`, to `reframe` on the record and to the summary. Answer them, restate the task, and run again. `--no-synthesis` skips this check, since there is no blend to stop.

Disagreement is kept as output. After synthesis (or the reframe), Concilium writes `dissent.json` next to `synthesis.md` and `reframe.md`, and puts a `## Dissent` section at the top of both. A record comes from: a judge whose top score goes to another candidate than the base (with both rationales; `overruled` by the evidence ranking); a valid or conflicting adversarial test the integration head still fails (`open`); a `quarantined` test, which fails everywhere and which no judge has classified as a real gap or an invalid test (`warning`, with the reason `quarantined: fails on base and every candidate; not classified by a judge`); a rejected graft (`overruled` by the gate, test or integrity check that failed after it, with its commit and revert, or `open` when the integrator never delivered it); a rubric criterion that judges of the same tie score more than 3 points apart (`open`); and a same-family judge or graft picker (`accepted-risk`, with its reason). Each record has an `id`, its `source`, a `summary`, `evidence` pointers (commits with SHAs, test ids, files, judges, the rubric's sha256), the `acceptanceClause` it is about (the test's `specClause`) when there is one, and a `resolution` with a `resolutionReason`. Open dissent on an acceptance line takes the "mergeable" label away: `result.patch` is still written and checked, but `mergeable` is `false` and `synthesis.mergeBlock` says which records block it. A `warning` never does: it is listed in `## Dissent` and in the summary (`Warning: <id> ...`) and leaves `mergeable` as it is. The summary lists open dissent, then warnings, right after the run line, and the JSON record carries `dissent` (`path` and `records`) right after `status`.

Every run leaves a decision trail next to `run.json`, written by Concilium itself, never by an agent. `decisions.tsv` gets one row per decision as it is made: the task type, the rubric freeze (with its sha256; the rubric goes to `rubric.json`), the candidates and roles, the gate plan, each candidate's verdict, the adversarial tests by validity, each judgment, the ranking, the synthesis base, each graft applied or rejected, the divergence check, the dissent and the mergeable label. Its columns are `ts`, `event`, `step`, `decision`, `chosen`, `alternatives`, `evidence` and `reason`; `evidence` holds pointers that must resolve (`commit:<sha>` in your repo, `file:<path>` in the run directory). Rows are only appended. `events.jsonl` is the run's event log: the start, each candidate, gate, adversary, test, judge and graft as it finishes, and each decision, which the row names by its `event` number. [`concilium trail check`](#concilium-trail-check) checks one against the other. When the run has an integration branch, `decisions.tsv`, `dissent.json` and `synthesis.md` are its last commit, under `.concilium/runs/<run-id>/`, so the trail ships with the change; `result.patch` is cut before that commit and does not carry them. `--no-trail-commit` keeps them in the run directory only. The record carries `trail` (`decisionsPath`, `eventsPath`, `rows`, `commitSha`, `errors`).

Each step is a role, and each role can be played by any agent CLI on any model (`cli[:model]`): the **planner** tailors the rubric and phrases the reframe questions (default: the first implementer); the **implementers** are the candidates (default: the installed, signed-in CLIs); the **adversaries** write the adversarial tests, at most one per model family (default `same-as-implementer`: the first candidate of each family; a configured adversary replaces its family's default, or attacks every candidate when no candidate is of its family); the **judge** orders ties and names the grafts (default `auto`: a usable CLI of another family, as above); the **integrator** folds in each graft (default `winner`: the base's CLI and model). A configured judge is used even when it is of a family it reads; its judgments and graft picks are then flagged same-family, with a warning, exactly like a picked one. Set roles with `--role`, in `.concilium/factory.yaml` or with `concilium config set <role>`, and see the result with [`concilium roles`](#concilium-roles). The resolved map is printed (on stderr) before the first candidate starts, shown in the summary, and recorded as `roles` on the run record.

It prints the open dissent first, then one row per candidate (status, verification verdict, files changed, lines added and removed, commits, duration, tokens), a table of gate results per lane (`base`, then each candidate), the integrity findings, the adversaries, the survival matrix with each test's validity and clause, each candidate's survival, the ranking with the judge's totals, the winner, each candidate's report, the grafts, the integration branch, the patch path and whether it is mergeable (or, when the candidates diverge, the lines in conflict and the questions), and the commands to inspect each branch and clean up. The run record (with `report` on each candidate, and `status`, `dissent`, `ranking`, `synthesis` and `reframe` on the run) is saved to `$XDG_DATA_HOME/concilium/runs/<run-id>/run.json`. The worktrees stay until you run `concilium gc --run <run-id>`, which keeps the integration branch. Nothing is merged into your branch. It exits 1 when no candidate finished `ok`, and 2 when the run ends in `reframe-needed`.

```
concilium code [options] [task...]
```

| Flag | Description |
|------|-------------|
| `--agents <list>` | Candidate agents (the implementer role), comma-separated, each `cli[:model]` (`claude,codex`, `claude:opus,codex:gpt-5.2-codex`). Default: the installed, signed-in agent CLIs, as for `run` |
| `--role <role=members>` | Who plays a role for this run: `planner`, `implementer`, `adversary`, `judge` or `integrator`, each member `cli[:model]` (`--role judge=codex:gpt-5.2`, `--role adversary=claude,gemini`). Repeatable; a list role adds up across flags. Beats `.concilium/factory.yaml` and saved config. See [`concilium roles`](#concilium-roles) |
| `--type <type>` | Task type, which picks the playbook and the default rubric: `bugfix`, `feature`, `refactor`, `perf`, `prototype`. Default: guessed from the task |
| `--cwd <path>` | Directory of the git repo to work on (default: current directory) |
| `--include-dirty` | Start every candidate from your uncommitted changes too (snapshotted to `refs/concilium/<run-id>/snapshot`). Without it a dirty tree is refused |
| `--timeout <minutes>` | Wall-clock limit per candidate and per adversary (default: 30) |
| `--no-verify` | Skip the gates and the integrity checks after the candidates finish, and with them the adversarial round |
| `--no-adversarial` | Skip the adversarial round (one adversary per model family writes tests that run on the base and every candidate) |
| `--no-judge` | Do not ask a judge CLI (from another model family when one is usable) to order candidates tied on the evidence; a tie at the top goes to the smallest diff |
| `--no-synthesis` | Do not graft ideas from the other candidates into the winner on the integration branch, and write no `result.patch` or `synthesis.md`. Also skips the divergence check that ends a run in `reframe-needed` (exit 2) |
| `--no-trail-commit` | Keep the decision trail (`decisions.tsv`, `dissent.json`, `synthesis.md`) in the run directory only, instead of committing it under `.concilium/runs/<run-id>/` as the last commit of the integration branch |
| `--json` | Print the run record as JSON to stdout (progress and errors go to stderr) |

**Examples:**

```bash
# Two candidates on the current repo
concilium code "add input validation to sum() with a test" --agents claude,codex

# A bug fix: every candidate follows the bugfix playbook
concilium code "sum() crashes on empty input" --type bugfix --agents claude,codex

# Pick the models per role: Opus plans and writes, Codex writes too, GPT-5.2 judges
concilium code "add a dry-run flag" --role planner=claude:claude-opus-5-5 --role implementer=claude:claude-opus-5-5,codex --role judge=codex:gpt-5.2

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

# Open dissent, and why the patch is not labelled mergeable
concilium code "sum() must reject non-numbers" --json | jq '{open: [.dissent.records[] | select(.resolution == "open") | {id, source, summary, acceptanceClause}], mergeBlock: .synthesis.mergeBlock}'

# The decision trail, and the commit that ships it on the integration branch
concilium code "sum() must reject non-numbers" --json | jq '.trail'
column -t -s $'\t' ~/.local/share/concilium/runs/<run-id>/decisions.tsv

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
| `set <role> <members>` | Save a code-council role: `planner`, `implementer`, `adversary`, `judge` or `integrator`, each member `cli[:model]` (comma-separated for `implementer` and `adversary`). See [`concilium roles`](#concilium-roles) |
| `reset` | Reset all config to defaults |
| `path` | Print the config directory path |

**Configuration priority** (highest wins, per setting):

1. `run` flags (`--juror-models`, `--chairman`) and the `deliberate()` options (`councilModels`, `chairmanModel`, `apiKey`)
2. Environment variables: `OPENROUTER_API_KEY`, `COUNCIL_MODELS` (jurors), `CHAIRMAN_MODEL`, `OPENROUTER_API_URL`
3. The `juror` and `chairman` roles of the repo's `.concilium/factory.yaml` (see [`concilium roles`](#concilium-roles))
4. Saved config (`concilium config set ...`); each `config set` changes only its own setting
5. Built-in defaults: no API key, and jurors and chairman chosen from the installed agent CLIs at run time

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

### `concilium roles`

Print who plays each role and where that came from: the code council's `planner`, `implementer`, `adversary`, `judge` and `integrator` (see [`concilium code`](#concilium-code)), the `verifier` of [`concilium pr`](#concilium-pr) and [`concilium verify-pr`](#concilium-verify-pr), and the plan council's `juror` and `chairman` (see [`concilium run`](#concilium-run)). Each member is `cli[:model]` (`claude`, `codex:gpt-5.2`, `opencode:openai/gpt-5.2`); jurors and the chairman may also be OpenRouter model ids. Per role, highest first:

1. Flags: `code --role` and `code --agents` (the implementers); `pr --role verifier=` and `verify-pr --role verifier=`; `run --juror-models` and `run --chairman`
2. Environment variables, for jurors and the chairman only: `COUNCIL_MODELS`, `CHAIRMAN_MODEL`
3. The `roles:` section of `.concilium/factory.yaml`, the nearest one from `--cwd` up to the repo root, read when the command runs
4. Saved config: `concilium config set <role> <members>` (jurors and chairman: `config set jurors`, `config set chairman`)
5. Defaults from [`concilium doctor`](#concilium-doctor) detection: the installed, signed-in CLIs implement and the first one plans, one adversary per implementer family (`same-as-implementer`), a judge of another family per tie (`auto`), the winner integrates (`winner`), a verifier of a family that wrote none of the shipped commit (`auto`), and the jurors and chairman as for `run`

```yaml
# .concilium/factory.yaml (only roles: is read today)
roles:
  planner: claude:claude-opus-5-5
  implementer: [claude:claude-opus-5-5, codex]
  adversary: same-as-implementer   # or a list, at most one per model family
  judge: codex:gpt-5.2             # or auto
  integrator: winner               # or cli[:model]
  verifier: gemini                 # or auto
  juror: [claude, codex:gpt-5.2]
  chairman: gemini
```

An unknown role, a list for a single-member role, a member that is not an agent CLI (for a code role or the verifier), an empty model or two adversaries of one family is an error naming the file and every problem, and `code`, `run` and `roles` exit 1 before running anything. A judge of an implementer family (or of an unknown family, such as OpenCode) is allowed, with a warning: its judgments of ties among its family and its graft picks are flagged same-family.

```
concilium roles [options]
```

| Flag | Description |
|------|-------------|
| `--cwd <path>` | Directory of the repo whose `.concilium/factory.yaml` applies (default: current directory) |
| `--role <role=members>` | Set a role for this preview, as `code --role` does (repeatable) |
| `--json` | Output as JSON: `roles` (each with `value` and `source`), `factoryPath`, `warnings`, `notes` |

**Examples:**

```bash
# The role map for this repo
concilium roles

# What a run with this judge would use
concilium roles --role judge=gemini --json | jq '.roles.judge'

# Save a default integrator for every repo
concilium config set integrator claude:claude-opus-5-5
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

### `concilium trail check`

Check the decision trail of a code run, in `$XDG_DATA_HOME/concilium/runs/<run-id>/`. Every row of `decisions.tsv` must be the decision event of `events.jsonl` it names, field for field and in event order, with at least one evidence pointer; every `commit:` pointer must name a commit in the run's repo and every `file:` pointer a file in the run directory; and every decision event must have exactly one row. A row added or edited by hand fails the check. It prints each problem with its line in `decisions.tsv` and exits 1 when there is one.

```
concilium trail check --run <id> [options]
```

| Flag | Description |
|------|-------------|
| `--run <id>` | The code run to check (required) |
| `--json` | Print `{runDir, rows, events, problems}` as JSON to stdout |

**Examples:**

```bash
concilium trail check --run 20261016T141015-a1b2c3
concilium trail check --run 20261016T141015-a1b2c3 --json | jq '.problems'
```

### `concilium gates`

List the actions Concilium paused instead of running. Concilium sorts every side effect of its own in three tiers: it runs what stays in the run (worktrees and `concilium/` branches, agent CLIs and gates in a worktree, the run store, reverting a graft, `gc`), runs and announces a dependency install or a rebase of the integration branch, and always pauses a push to any remote, opening, merging or closing a pull request, a write to your checkout or to a branch outside `concilium/`, a delete outside the run's own worktrees and branches, a deploy and a message to a person. A paused action is a gate: an entry in `gates.json` and `gates.md` in `$XDG_DATA_HOME/concilium/runs/<run-id>/`, with its id (`<run-id>-g<n>`), the exact command and the directory it runs in, the reason and the time. It runs only when you approve that gate. An approval covers one gate and never a later one, even with the same command. Status is `pending`, `approved` (its command started), `executed`, `failed` (with the exit code and the end of the output), `rejected` or `superseded` (a newer request of its kind replaced it while it was pending; it can never be approved). `concilium pr` is the first command that pauses: it asks for a push and a pull request.

```
concilium gates [options]
```

| Flag | Description |
|------|-------------|
| `--run <id>` | Only the gates of this run |
| `--json` | Print the gate entries as JSON to stdout |

### `concilium approve`

Approve one pending gate and run its exact command, without a shell, in its directory, with your environment. It prints the command, the exit code and the output, and exits 1 when the command fails, when the gate is unknown, or when it was already approved, rejected or superseded.

```
concilium approve <gate-id>
```

### `concilium reject`

Reject one pending gate. Its command never runs, and a rejected gate cannot be approved later.

```
concilium reject <gate-id>
```

**Examples:**

```bash
concilium gates
concilium gates --run 20261016T141015-a1b2c3 --json | jq '.[] | select(.status == "pending")'
concilium approve 20261016T141015-a1b2c3-g1
concilium reject 20261016T141015-a1b2c3-g2
```

### `concilium pr`

Ship a code run as a pull request: its integration branch, `concilium/<run-id>/integration`, or, for a run with a single candidate (no integration branch), that candidate's branch. It never pushes or opens anything itself. First it verifies the commit to ship as `concilium verify-pr` does and saves the verdict. Then it writes the PR body to `pr-body.md` in the run directory (the verdict, a same-family warning when there is one, a dissent summary, a pointer to the decision trail and `synthesis.md`) and asks for two gates: a push of exactly the verified commit, by SHA, to `concilium/<run-id>` on the remote (`git push <remote> <sha>:refs/heads/concilium/<run-id>`), and `gh pr create` from that branch with the task's first line as the title and `pr-body.md` as the body. A commit on the branch after the verdict is never pushed, even when you approve later. It prints both gate ids and the `concilium approve` commands; approve the push first. The pull request is opened as a draft unless the verdict is `PASS` or `PASS+NOTES` from a verifier outside the author families; it prints why. Run it again for the same commit and it prints the same gates instead of asking again; once the commit changed, the pending gates of the old one are `superseded` and new ones are asked for. Merging stays with you; Concilium has no merge command.

```
concilium pr <run-id> [options]
```

| Flag | Description |
|------|-------------|
| `--remote <name>` | The remote to push to (default: `origin`) |
| `--base <branch>` | The pull request's base branch (default: the remote's default branch) |
| `--role <role=member>` | The verifier for this run, as `verifier=<cli[:model]>`, over `factory.yaml` and saved config; no other role applies |

### `concilium verify-pr`

Verify the commit a code run would ship, preferring a model family that wrote none of it. The commit is the branch head (see [`concilium pr`](#concilium-pr)), or its parent when the head is the run's decision trail commit and touches only `.concilium/runs/`: the trail stays on the branch and in the run directory, never in the pull request. A commit that would still carry `.concilium/runs/` files (for example a commit after the trail commit) is `BLOCKED` with nothing to push. The author families are the base candidate's, and each committed graft's donor and integrator, or the single candidate's. The verifier is the configured `verifier` role (`--role verifier=`, `factory.yaml`, `config set verifier`) when its CLI is installed, signed in and of a family outside them, else the first installed, signed-in agent CLI (in `claude`, `codex`, `gemini`, `opencode` order) of a known family outside them. When there is none, an author-family CLI verifies (the configured one first): the verdict records `sameFamily: true` with the reason, `verification.md`, the PR body, `pr` and `status` say so, and the pull request is always a draft. It is `BLOCKED` only when no agent CLI is usable at all. In a fresh worktree detached at the commit, it re-runs the run's gates and its valid adversarial tests (`evidence` and `regression-guard`), then the verifier CLI reviews the diff read-only and answers `PASS`, `NOTES` or `FAIL`. The verdict is `FAIL` when a gate that passes on the base, a valid test or the review fails; `PASS+NOTES` when a gate fails on the base too or the review has notes; `BLOCKED` when the review gives no verdict; `PASS` otherwise. It is keyed to the commit's SHA, the base SHA and the `git patch-id` of the diff, saved as `prVerdict` in the run record (with the branch head it read and the trail commit it left out) and written to `verification.md` in the run directory. It exits 1 unless the verdict is `PASS` or `PASS+NOTES`.

```
concilium verify-pr <run-id> [options]
```

| Flag | Description |
|------|-------------|
| `--role <role=member>` | The verifier, as `verifier=<cli[:model]>`, over `factory.yaml` and saved config; no other role applies |

### `concilium status`

Show a code run's gates and its verdict. The verdict is void when the branch head differs from the head it verified, or when the pushed branch, as this repo last saw it (`<remote>/concilium/<run-id>`, read locally, with no network call), is at another commit than the one verified. Run `concilium verify-pr` again after a new commit. Given a factory id (see [`concilium factory`](#concilium-factory)), it prints the factory's summary instead.

```
concilium status <run-id>
```

**Examples:**

```bash
concilium pr 20261016T141015-a1b2c3 --base main
concilium approve 20261016T141015-a1b2c3-g1   # the push
concilium approve 20261016T141015-a1b2c3-g2   # the pull request
concilium status 20261016T141015-a1b2c3
concilium verify-pr 20261016T141015-a1b2c3 --role verifier=gemini
```

### `concilium factory`

Turn a spec into a stack of verified branches. The planner role (by default the first implementer's CLI, with its model) reads the spec file in one read-only run and answers a task list: each task has an `id`, a `title`, a `type` (`bugfix`, `feature`, `refactor`, `perf`, `prototype`), `acceptance` lines and `depends_on`. The list is rejected, with every problem named and before any code runs, when it is empty, a task has no acceptance line, an id is used twice, a type is unknown, or a dependency is unknown or part of a cycle. The tasks are saved as `tasks.json` and `tasks.md` in the factory's run directory (`$XDG_DATA_HOME/concilium/runs/<factory-id>/`), in dependency order (otherwise in the planner's order).

Then each task gets one `concilium code` run, one at a time, with the gates, synthesis and the decision trail always on: its candidates are briefed with the task's title and acceptance lines, and its type picks the playbook. The first task starts from `HEAD`; each later task starts from the commit the task before it shipped, so the integration branches stack locally. The checkout is never touched, and uncommitted changes are not included. Each task's commit is verified at its own head as `concilium verify-pr` does (the verdict is saved on that run). The chain stops at the first task that ends in `reframe-needed`, whose candidates all failed, that has nothing to ship, or whose verdict is not `PASS` or `PASS+NOTES`; the tasks after it are `not run`. `factory.json` records the spec's path and sha256, the planner, the tasks, and per task its run id, base, verified head and verdict; it is rewritten after every task.

It never pushes or opens a pull request. The summary prints, in order, the `concilium pr` command of each shipped task, each one based on the branch of the one before it (`--base concilium/<run-id>`). It exits 0 when every task shipped, 2 when a task ended in `reframe-needed`, and 1 otherwise.

```
concilium factory <spec> [options]
```

| Flag | Description |
|------|-------------|
| `--cwd <path>` | Directory of the git repo to work on (default: current directory) |
| `--agents <list>` | Candidate agents for every task, the implementer role (default: the installed, signed-in agent CLIs) |
| `--role <role=members>` | Who plays a role: `planner` (splits the spec), `implementer`, `adversary`, `judge`, `integrator` or `verifier`, as `cli[:model]`; repeatable |
| `--timeout <minutes>` | Wall-clock limit per candidate and per adversary in minutes, in every task |
| `--no-adversarial` | Skip the adversarial round in every task |
| `--no-judge` | Do not ask a judge CLI to order tied candidates in any task |
| `--json` | Output the factory record as JSON to stdout |

**Examples:**

```bash
concilium factory spec.md --role planner=claude --role verifier=gemini
concilium status 20261017T092657-640fda
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
