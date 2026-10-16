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
npm run typecheck                            # core + cli project refs, desktop --noEmit
npm test                                     # vitest in core, cli, desktop
npm run lint -w concilium                    # eslint in desktop
node packages/cli/dist/bin/concilium.js --help   # the built CLI starts
```

Faster loops while working:

```bash
npm run test -w @concilium/core              # core only
npm run test -w @concilium/cli               # cli only
npx vitest run packages/core/src/services/deliberation-service.test.ts
```

All six commands must exit 0. A change is not verified until they do.

## Feature map

| Feature | Test | What it pins |
|---|---|---|
| CLI command surface | `packages/cli/bin/concilium.test.ts` | `--help` and `run --help` text (snapshots in `bin/__snapshots__/`), every command is registered, `--version` matches `package.json` |
| Full deliberation (Stage 1 → 2 → 3) | `packages/core/src/services/deliberation-service.test.ts` | Agent plans become Stage 1, anonymized juror rankings aggregate to the right leaderboard, chairman output becomes Stage 3, stage events fire 1→2→3, the run record is persisted and listed in history |
| Degraded runs | same file | One surviving agent: ranking skipped, its plan is the answer. No OpenRouter key: Stage 2/3 skipped with a note. All agents fail: error event, rejected promise, nothing persisted |
| Ranking parser | `packages/core/src/domain/deliberation/ranking.test.ts` | `FINAL RANKING:` numbered list is read and earlier mentions are ignored |
| Desktop analytics formatting | `desktop/src/renderer/utils/analytics.test.ts` | Cost, token and duration display strings |

Not covered by any test yet: the real provider adapters (`claude-provider`, `codex-provider`, `opencode-provider`), `OpenRouterGateway` HTTP calls, the Ink UI, the `history`/`config`/`models` command output, and the Electron main/renderer.

## How the offline e2e works

`deliberation-service.test.ts` builds a real `DeliberationService` and swaps only the two ports that touch the outside world:

- `FakeAgentProvider` implements `AgentProvider` and returns a fixed plan, or an error.
- `FakeLlmGateway` implements `LlmGateway`. Jurors read the anonymized ranking prompt and rank the response containing a preferred plan first. The chairman returns a fixed synthesis.

Config, secrets and run history use the real `JsonConfigStore`, `PlaintextSecretStore` and `JsonRunRepository` in a `mkdtemp` directory. `OPENROUTER_API_KEY`, `COUNCIL_MODELS`, `CHAIRMAN_MODEL` and `OPENROUTER_API_URL` are stubbed empty, so the temp config is the only source.

To test a new pipeline behavior, add a case there. Change the fakes' inputs, then assert on the returned `RunRecord`, the recorded events, or what `JsonRunRepository` reads back.

## When to add or update tests

- **Changed a CLI flag, command or description:** run `npx vitest run packages/cli -u`. Read the snapshot diff and confirm every line of it was intended, then commit the `.snap` file with the change.
- **Changed deliberation, ranking, prompts or persistence:** add or extend a case in the offline e2e or a co-located unit test (`file.ts` → `file.test.ts`).
- **Fixed a bug:** first write a test that fails on the bug, then fix it.
- **Added a provider or gateway adapter:** keep it behind its port. Put the parsing logic in a pure function and test that with recorded fixtures. Never call the real service in tests.

## Rules for tests

- Assert on public outputs: the `RunRecord`, the events emitted, the files written, the CLI's stdout. Don't assert on private helpers or call counts unless the count is the contract.
- Check that a new test catches a defect: break the code it covers once and see the test fail.
- No network, no real binaries, no `~`: use temp dirs and pass `HOME`/`XDG_*` overrides to any spawned CLI (see `concilium.test.ts`).
- New files need the MIT license header (see `AGENTS.md`).
