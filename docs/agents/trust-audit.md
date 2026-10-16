# Agent trust audit

- Repo: concilium · Branch: plan/factory-layer3 @ a0e28b6 · Date: 2026-10-16
- Previous audit: none

Scope note. This audit ran from branch `plan/factory-layer3`. That branch only adds three docs (`docs/plans/factory-architecture.md`, `docs/plans/factory-layer3.md`, `docs/research/software-factory-landscape.md`) on top of `origin/main` at `76ed252`. Every code finding below therefore describes `origin/main`. The only effect of the branch is on the guidance metrics: the two plan docs add 4 of the 6 home-directory references and the skill citations.

Environment: Linux, Node v24.19.0, npm 11.17.0. `npm install` resolved TypeScript 5.7.3, vitest 4.1.12 and ESLint 8.57.1. There is no committed lockfile, so these versions are whatever npm resolved on 2026-10-16. Another clone on another day can get different ones.

## Scorecard

Score each layer 0–3: 0 absent, 1 present but not trustworthy, 2 solid with gaps,
3 an agent can rely on it unsupervised.

| Layer | Score | One-line evidence |
|---|---|---|
| Verification | 0 | 0 test files. `npm test` exits 1 ("No test files found") in core and desktop. The documented dev entry point `npm run dev -w @concilium/cli` crashes. There is no verification skill, feature map or golden file. |
| Codebase as memory | 1 | 3 composition roots, a desktop copy of core types, 4 error classes that nothing throws, 2 identical secret stores, 3 CLI flags that nothing reads. A tracked `tsconfig.tsbuildinfo` breaks the clean-clone build. |
| Static analysis | 1 | Strict tsc is configured, but there is no `typecheck` script and no gate. Desktop has 4 live type errors. ESLint 8 covers `desktop/` only, and there is no lockfile. |
| Rules / skills | 1 | `AGENTS.md` has 292 lines and documents a `gui` command and test files that don't exist. There is no `CLAUDE.md`, no skill in the repo, and `.claude/settings.local.json` is tracked. |
| Style guide / human review | not assessed | Reading PR review comments needs `gh` (remote access), which this audit was not authorized to use. |
| Outer loop | 0 | No CI configuration at all (`.github/` is absent) and no automation. |

## Top gaps

1. **No green baseline exists.** Measured on a fresh `npm install`:
   - `npm run build` exits 2. The tracked `packages/core/tsconfig.tsbuildinfo` makes tsc skip declaration emit, so core gets 34 `.js` files and **0 `.d.ts`**. The CLI then fails with 38 errors (TS2307 `Cannot find module '@concilium/core'` plus knock-on TS7006).
   - The same core build with a fresh buildinfo emits all 34 `.d.ts`.
   - `npm test` exits 1 because no test files exist.
   - `tsc --noEmit -p desktop` exits 2 with 4 errors (`TitleBar` lost its `subtitle` prop in `fb2f462` "remove dead code", and 4 call sites still pass it).

   An agent cannot tell whether its own change broke anything, because the baseline is already red and nothing checks it.
2. **Zero verification.** There are 0 `*.test.*` files, although `AGENTS.md:96` points at `ranking.test.ts`. There is no CI, no goldens, no verification skill and no feature map. The CLI dev path crashes (`bin/concilium.ts:11` requires `../../package.json`, which only resolves from `dist/bin`). The only way to see the product run is to build it by hand and call it with real CLI subscriptions and an OpenRouter key. `fb2f462` already shows the cost: a "remove dead code" commit shipped 4 type errors because nothing ran tsc on desktop.
3. **The prose guidance is wrong where agents read first.** Nothing enforces 7 of the 8 machine-checkable rules in `AGENTS.md` (table below). Several are false today:
   - The `gui` command does not exist (`concilium --help` lists run, history, config, models).
   - The documented test file does not exist.
   - "Add MIT license header" is followed by 8 of 93 TS files.
   - "No `console.log` in core/cli" is broken by 79 call sites in `packages/cli/src`. They are legitimate CLI output, so the rule itself is wrong for the CLI.
   - The custom error classes the guide prescribes are thrown 0 times.

   Agents copy what they see, so every one of these rules is effectively dead.

## Prose rules vs enforcement

| Rule (source) | Enforced by | Status |
|---|---|---|
| TypeScript strict, `noImplicitAny` (`AGENTS.md:117-121`) | `tsconfig.base.json` sets `strict`, but no script or CI runs `tsc --noEmit` | enforceable via `typecheck` script + CI. **Violated** today in desktop (4 errors). |
| ESLint passes (`AGENTS.md:285`, `CONTRIBUTING.md:98`) | `desktop/.eslintrc.json` only, run by hand | enforceable via root flat config + CI. Core and CLI have no lint. Measured: desktop exit 0, 7 warnings. |
| Tests pass (`AGENTS.md:284`, `CONTRIBUTING.md:129-135`) | `vitest run` with no tests exits 1 | enforceable via CI once tests exist. Vacuous today. |
| MIT license header on new files (`AGENTS.md:147-154`, `:287`) | none | enforceable via a header test or lint rule (with a ratchet: 85 files lack it). Guidance only today. |
| No `console.log` in core/cli (`AGENTS.md:286`) | none | core complies (0 outside `logger.ts`). The CLI has 79 lines of user-facing output. **Rewrite the rule** (core only, or "CLI output goes through formatters"), then enforce via eslint `no-console` scoped to `packages/core`. |
| Use `createLogger`, never swallow errors (`AGENTS.md:156-158`) | none | partly enforceable (`no-console` in core, `no-empty` catch). **Violated**: `config-service.ts:30-35` drops a decrypt error. |
| Use `ConciliumError`/`ConfigError`/`PipelineError`/`AgentError` (`AGENTS.md:161`) | none | **Violated**: 0 throws. 8 throws use plain `Error` (5 in core, 3 in desktop). Either delete the classes and the rule, or enforce them via a lint rule (`no-restricted-syntax` on `new Error` in core). |
| Import order (`AGENTS.md:123-128`) | none | enforceable via `eslint-plugin-import` `import/order`. |
| Explicit return types on exported functions (`AGENTS.md:119`) | none | enforceable via `@typescript-eslint/explicit-module-boundary-types`. |
| Core is framework-agnostic and never imports cli/desktop (`AGENTS.md:47-53`) | none (holds today by inspection) | enforceable via `no-restricted-imports` or dependency-cruiser in `packages/core`. |
| IPC: validate data both ways (`AGENTS.md:214`) | none | guidance only (partly enforceable via schema tests). `ipc.ts:116` passes a renderer-supplied id into `JsonRunRepository.load`. |
| `client:visible` by default for islands (`AGENTS.md:218-219`) | none | guidance only |
| "Changes in core don't break cli or desktop" (`AGENTS.md:290`) | none | enforceable via `tsc -b` across workspaces in CI. **Broken today.** |
| Node 18+ (`CONTRIBUTING.md:49`, `engines`) | none | stale (Node 18 and 20 are end of life). Enforce via CI matrix + `engines`. |
| Per-package `npm install` (`CONTRIBUTING.md:55-66`) | none | stale. This is an npm workspace and installs run from the root. |

## Backlog

Ordered: subtract → guardrails → verification → architecture → outer loop.

### 1. Subtract
- [ ] **Untrack build artifacts and local settings**: `git rm --cached packages/core/tsconfig.tsbuildinfo .claude/settings.local.json`. Add `*.tsbuildinfo` and `.claude/settings.local.json` to `.gitignore`. This is a **build fix**, not hygiene: the tracked buildinfo stops core emitting `.d.ts`. Evidence: tracked files, measured build (Appendix B.2). Verify: fresh clone, `npm install && npm run build` exits 0 and `find packages/core/dist -name '*.d.ts' | wc -l` prints 34. Size: S. Skill: `deslop`.
- [ ] **Prune stale `.gitignore` entries**: drop the Python block, `.venv`, `frontend/*` and `data/` (no such paths exist). Stop ignoring `package-lock.json` (see Guardrails). Evidence: `.gitignore`. Verify: `git status` clean after `npm install`. Size: S. Skill: `deslop`.
- [ ] **Delete dead code that needs no decision**:
  - the unused barrel `packages/core/src/adapters/parsers/index.ts` (nothing imports it);
  - `TerminalSecretStore` (byte-for-byte copy of `PlaintextSecretStore`);
  - the 2024-era OpenRouter `FALLBACK_MODELS` (`openrouter-gateway.ts:9`);
  - the misplaced `eslint-disable` at `opencode-provider.ts:428` (it sits 4 lines above the `as any` and core has no lint anyway).

  Evidence: subagent pass, `factory-layer3.md` A2/A7. Verify: `rg "TerminalSecretStore|FALLBACK_MODELS|parsers/index"` returns nothing, and typecheck stays green. Size: S. Skill: `deslop`.
- [ ] **Delete or implement the unused flags** `--stage1-only`, `--jurors`, `--format`. Each is declared in `run.ts:83-88`, appears in `concilium run --help` (measured), and is read nowhere. Verify: `rg "stage1Only|jurors\?|format\?" packages/cli/src` returns only the code that uses them. Size: S. Skill: `deslop`. Decision needed only for `--stage1-only` (plan F1).
- [ ] **Delete the backup skill copy** `~/.claude/skills/crypto-rules-creator.backup-20260527091425` (personal dir, not this repo; unrelated to Concilium). Size: S.

### 2. Guardrails
- [ ] **Reproducible install**: commit `package-lock.json` and switch docs to `npm ci`. Evidence: without a lockfile, `npm ls vite` resolves two majors (6.4.4 and 7.3.7). Under plain `tsc` this gives a `Plugin<any>[]` type error in `website/astro.config.mjs:14`. Verify: `npm ci` from a clean clone. Size: S. Skill: `principle-encode-lessons-in-structure`.
- [ ] **Typecheck gate that is green**: add a root `typecheck` script (`tsc -b packages/core packages/cli && tsc --noEmit -p desktop`). Fix the 4 desktop errors by deleting the stale `subtitle` props (`AnalyticsScreen.tsx:255`, `ResultsScreen.tsx:42`, `RunningScreen.tsx:237,258`) or restoring the prop. Verify: `npm run typecheck` exits 0. Size: S. Skill: `principle-encode-lessons-in-structure`.
- [ ] **Make `npm test` honest before tests exist**: add one real smoke test per package with a `test` script. Do not use `--passWithNoTests`, which would turn "no tests" into green. Add a `test` script to the CLI. Verify: `npm test` exits 0 and runs ≥1 test per workspace. Size: S. Skill: `tdd`.
- [ ] **Repo-invariant tests**: (a) license header present, with a ratchet allowing at most 85 missing files (count may only go down); (b) every command and flag listed in `AGENTS.md`/READMEs appears in `concilium --help`; (c) `packages/core` imports nothing from `cli`/`desktop`/`electron`. Evidence: prose rules table. Verify: each test fails when mutated. Size: M. Skill: `principle-encode-lessons-in-structure`, `tdd`.
- [ ] **One lint config for all workspaces**: root flat ESLint config covering `packages/*` and `desktop/` with `no-console` scoped to core and `import/order`. Count suppressions (4 today) and make the count a ratchet. Replace `@ts-ignore` in `website/src/components/Hero3D.tsx:2` with a module declaration. ESLint 8 is end of life. Verify: `npm run lint` exits 0 at root. Size: M. Skill: `principle-encode-lessons-in-structure`.
- [ ] **Rewrite the guidance that is false**: drop `gui` from `AGENTS.md:21`, README and CHANGELOG. Point the test example at a real file. Scope the `console.log` rule to core. Fix `CONTRIBUTING.md` setup (root `npm ci`, Node ≥22). Add a `CLAUDE.md` symlink to `AGENTS.md`. Remove the `/Users/matiasdaloia/...` paths (tracked `settings.local.json`). Verify: the doc-vs-help test from the item above. Size: S. Skill: `technical-writing`.

### 3. Verification
- [ ] **Fix the CLI dev entry point**: `packages/cli/bin/concilium.ts:11` (`require("../../package.json")`) crashes under `npm run dev -w @concilium/cli`. Resolve the version so it works from both `bin/` and `dist/bin/`. Verify: `npm run dev -w @concilium/cli -- --help` exits 0. Size: S. Skill: `tdd`.
- [ ] **Stop logging at module load**: `resolveCodexBinaryPath` prints an INFO line on every CLI invocation, `--help` included. That pollutes any golden of CLI output. Verify: `concilium --help` output has no log line. Size: S. Skill: `principle-fix-root-causes`.
- [ ] **Characterization tests and goldens** for `ranking.ts`, `prompts.ts`, `claude-parser.ts` (recorded stream-json fixtures), `json-run-repository.ts` and `ConfigService.resolve`, plus a golden of `concilium --help` and `concilium run --help`. Verify: ≥25 tests, and each fails under one recorded mutation. Size: M. Skill: `tdd`, `principle-test-behavior-not-implementation`.
- [ ] **Offline end-to-end run**: a fake `AgentProvider` and fake `LlmGateway` wired through the real `DeliberationService`. Then `concilium run "x" --json --no-save` completes all 3 stages with no keys and no network, and is checked against a golden RunRecord shape with exact values for seeded fields. Today a run needs real CLI subscriptions plus `OPENROUTER_API_KEY`. Size: M. Skill: `tdd`.
- [ ] **Verification skill + feature map** in `.claude/skills/verify-concilium/`: a script that builds, runs the offline e2e and `history`, and collects outputs. Also a feature map covering CLI commands and flags, desktop screens (Home, Running, Results, Analytics) and how to reach each. Verify: a fresh agent can answer "does `--output` work?" by running the skill. Size: M. Skill: `create-verification-skill`.
- [ ] **Desktop smoke** (later): Electron has 39 UI files and no UI check. Consider the `e2e` runner once the desktop unfreezes (plan M9), with telemetry disabled. Size: L. Skill: `e2e`.

### 4. Architecture (needs owner decisions)
- [ ] **One composition root**: `buildProviders` and the wiring exist 3 times (`cli/src/commands/run.ts`, `cli/src/index.ts`, `desktop/src/main/ipc.ts`). Decision needed: is `createConciliumRuntime(adapters)` in core the paved path? (Plan M0.4.) Skill: `architect`.
- [ ] **One provider registry**: provider identity is hardcoded in ≥6 places (plan A3.9). Decision needed: the registry shape and whether capabilities live in it. Skill: `architect`.
- [ ] **Desktop imports core types**: `desktop/src/renderer/types/index.ts` redefines core types and has already drifted (`rawOutput` is required there and optional in core). Decision needed: renderer-safe type-only export from core. Skill: `architect`.
- [ ] **Error-class policy**: use the 4 classes (enforced) or delete them. Decision needed. Skill: `architect`.
- [ ] **Desktop `File.path` bug**: `HomeScreen.tsx:303` uses `@ts-expect-error` to read `File.path`, which Electron removed in v32. The app is on 40.2.1, so the branch is dead. Decision needed: fix with `webUtils.getPathForFile` now, or freeze until M9. Skill: `principle-fix-root-causes`.

### 5. Outer loop
- [ ] **CI on PRs**: `.github/workflows/ci.yml` running `npm ci`, `typecheck`, `lint`, `test`, and the offline e2e on Node 22 and 24. Pin actions by SHA. Size: S. Skill: `fix-ci`, `babysit`.
- [ ] **Scheduled re-audit** of this file monthly, plus a `maintain-verification-skill` pass to keep the feature map current. Only after CI is green for a few weeks. Size: S. Skill: `schedule`.

## Metrics

```
ci.workflows=0
guidance.adrs=0
guidance.home_dir_refs=6
guidance.home_skill_drift=0
guidance.home_skills_related=7
guidance.in_repo_skills=0
guidance.nested_agents_md=0
memory.debt_markers=0
memory.git_worktrees=1
memory.local_branches=2
memory.tracked_junk=4
memory.workaround_phrases=0
pin.actions_by_tag=0
pin.unpinned_refs=0
static.suppressions=4
verify.feature_map=0
verify.golden_files=0
verify.skip_calls=0
verify.test_files=0
verify.tool_gated_skip_files=0
verify.ui_files=39
verify.verification_skill=0
```

Reading the metrics:
- `memory.tracked_junk=4` is mostly false positives. `desktop/bin/concilium.js` and `packages/cli/bin/concilium.ts` are real entry points, and `website/.vscode/*` (2 files) is minor. The real tracked junk the script misses is `packages/core/tsconfig.tsbuildinfo` and `.claude/settings.local.json`.
- `guidance.home_skills_related=7` comes from skill names cited in the new plan docs (`poteto-mode`, `show-me-your-work`, and so on). No repo workflow depends on them.
- `debt_markers=0` and `workaround_phrases=0` are genuinely clean.

Repo-specific metrics measured by hand (rerun with Appendix A):

```
repo.ts_files=93
repo.ts_files_missing_license_header=85
repo.cli_console_lines=79
repo.custom_error_throws=0
repo.composition_roots=3
repo.unused_cli_flags=3
repo.desktop_type_errors=4
repo.core_dts_emitted_with_tracked_buildinfo=0
repo.core_dts_emitted_with_fresh_buildinfo=34
```

## Changes since previous audit

None. This is the first audit.

## Verification facts (measured)

All commands ran from the repo root on 2026-10-16 after `npm install`. Exit codes come from the shell.

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm install --no-audit --no-fund` | 0 | 1356 packages in 60s. 8 packages with install scripts (electron, esbuild, sharp, …) were flagged as not covered by `allowScripts`. Deprecation warnings for eslint@8.57.1, glob 7/8/10, tar@6, rimraf 2/3. It wrote `package-lock.json`, which is gitignored, so no tracked file changed. |
| 2 | `npx tsc --noEmit -p packages/core` | 0 | clean |
| 3 | `npx tsc --noEmit -p packages/cli` (before core `dist/` existed) | 2 | 38 errors: TS2307 `Cannot find module '@concilium/core'` in 16 files, plus TS7006 implicit any as a knock-on. The CLI resolves core through `dist/` (`packages/core/package.json` `types: ./dist/index.d.ts`). |
| 4 | `npm run build` (documented root build) | 2 | `build:core` "succeeds" but emits 34 `.js` and **0 `.d.ts`**. `build:cli` then fails with the same 38 errors. It also rewrote the tracked `packages/core/tsconfig.tsbuildinfo` (reverted with `git restore`). |
| 5 | `npx tsc -p packages/core --outDir /tmp/concilium-core-fresh --tsBuildInfoFile /tmp/concilium-core-fresh.tsbuildinfo` | 0 | 34 `.d.ts` emitted. This confirms the tracked buildinfo causes #4. |
| 6 | `npx tsc -p packages/core --tsBuildInfoFile /tmp/concilium-core-dist.tsbuildinfo`, then `npx tsc --noEmit -p packages/cli` | 0 / 0 | The CLI typechecks clean once core declarations exist. |
| 7 | `npx tsc --noEmit -p desktop` | 2 | 4 × TS2322 `Property 'subtitle' does not exist` at `AnalyticsScreen.tsx:255`, `ResultsScreen.tsx:42`, `RunningScreen.tsx:237`, `RunningScreen.tsx:258`. `TitleBar` takes no props since `fb2f462`. |
| 8 | `npx astro check --root website` | n/a | Could not run. It needs `@astrojs/check`, which is not a dependency, and it prompted to install it. I declined, since installing it would change `package.json`. |
| 9 | `npx tsc --noEmit -p website` (fallback, not authoritative) | 2 | `astro.config.mjs:14`: a `Plugin<any>[]` type mismatch from two vite majors (6.4.4 and 7.3.7). `src/pages/api/waitlist.ts:19-20`: `import.meta.env` is untyped without `astro sync`. Treat the website typecheck as **unknown**, not failed. |
| 10 | `npm test` (root, `--workspaces --if-present`) | 1 | core: `vitest run` reports "No test files found, exiting with code 1". desktop: same. The CLI has no `test` script. |
| 11 | `npm run lint -w concilium` | 0 | 0 errors, 7 warnings: 5 × `no-non-null-assertion` (`ipc.ts:188`, `App.tsx:49,58`, `main.tsx:6`, `HomeScreen.tsx:214`) and 2 × `no-unused-vars` (`AnalyticsScreen.tsx:16`, `ResultsScreen.tsx:10`). Core and CLI have no lint script. |
| 12 | `npm run dev -w @concilium/cli -- --help` | 1 | `Error: Cannot find module '../../package.json'` from `packages/cli/bin/concilium.ts:11`. |
| 13 | `npx tsc -p packages/cli --tsBuildInfoFile /tmp/concilium-cli.tsbuildinfo && node packages/cli/dist/bin/concilium.js --help` | 0 | Lists `run`, `history`, `config`, `models` (no `gui`). It prints an INFO log line from `resolveCodexBinaryPath` first. |

Not run: `npm run start -w concilium` (needs a display), any real `concilium run` (needs agent CLI subscriptions and `OPENROUTER_API_KEY`), `astro build`, and PR review history (no remote authorization).

Left on disk: `node_modules/`, `package-lock.json`, `packages/core/dist/` and `packages/cli/dist/`. All are gitignored. `git status --porcelain` is empty apart from this report.

## Cross-check against milestone M0 (`docs/plans/factory-layer3.md`)

### What M0 already covers

M0 already contains most of this backlog's content:
- **M0.1**: lockfile, untracking `tsbuildinfo` and `settings.local.json`, root ESLint, typecheck scripts, `engines`, CI.
- **M0.2**: characterization tests and fixtures.
- **M0.3**: subtracting `TerminalSecretStore`, `FALLBACK_MODELS`, unused flags and doc drift.
- **M0.4**: one composition root and a provider registry.
- **M0.5**: the defects.

The plan's own Appendix A says "the current typecheck and test state is unknown". This audit measured it, and the measurements change M0.

### Gaps: facts M0 does not account for

1. **The tracked `tsbuildinfo` is a build blocker, not hygiene.** M0.1 lists untracking it next to other cleanup. In fact `npm run build` fails from a clean install because of it (#4, #5). This has to be the very first change, or every later acceptance check fails for an unrelated reason.
2. **Desktop has 4 live type errors.** M0.1's acceptance ("`npm run typecheck` passes") cannot be met until they are fixed. M0 does not mention them.
3. **`npm test` cannot pass in M0.1.** M0.1's acceptance includes `npm test`, but tests only arrive in M0.2, and `vitest run` with no files exits 1. So M0.1 as written is unsatisfiable on its own.
4. **The CLI dev entry point is broken** (#12). M0.2's acceptance and every later real-artifact check need a runnable CLI. M0 does not mention it.
5. **The website has no typecheck path.** `astro check` needs an uninstalled dependency, and two vite majors come from the floating install. M0.1 says "flat config at the root covering `packages/*` and `desktop/`" and leaves `website/` out of CI entirely. Decide explicitly: in CI, or out of scope.
6. **There are no repo-invariant checks.** M0 adds lint and tests but no tests for the repo's own rules: license header (85/93 missing), docs-vs-`--help`, and core import boundaries. M0.3's acceptance "docs list only commands that `--help` prints" is checked once by hand; it should be a test so it can't regress.
7. **The guidance rules themselves are wrong.** M0.3 fixes `gui` and the test paths but not the `console.log` rule (79 CLI lines; the rule should be scoped to core), the license-header rule (needs a ratchet or a mass fix), `CONTRIBUTING.md` (per-package installs, Node 18), or the missing `CLAUDE.md` symlink.
8. **There is no verification skill or feature map.** M0.2's fixture repos are for layer 3 targets. Nothing lets an agent verify Concilium itself end to end offline: no fake provider/gateway e2e and no skill. Every later milestone's "real-artifact check" needs that harness.
9. **Small items are missing**: the module-load INFO log (breaks `--help` goldens), the unused `parsers/index.ts` barrel, the misplaced `eslint-disable` and the `@ts-ignore` in `Hero3D.tsx`, stale `.gitignore` entries, and the `File.path` dead branch in `HomeScreen.tsx:303`.

### Items to add to M0

- **M0.0 Green baseline** (new, first): untrack `tsbuildinfo` and `settings.local.json`, commit the lockfile, add `typecheck`, fix the 4 desktop type errors, fix the CLI `bin` version require, and add one smoke test per workspace so `npm test` is honest. Add minimal CI running exactly these.
- **M0.2 additions**: a `--help` golden, an offline fake-provider e2e through `DeliberationService`, and a `verify-concilium` skill with a feature map.
- **M0.3 additions**: repo-invariant tests (header ratchet, docs-vs-help, core import boundary), fixes to the wrong rules, the `parsers/index.ts` barrel, the module-load log line, and `.gitignore` pruning.
- **M0.1 narrowed** to the ESLint flat config at the root (all workspaces), the TypeScript upgrade, `engines >=22`, and the Node 22/24 CI matrix. The lockfile, untracking and basic CI move to M0.0.

### Recommended order

`M0.0 (green baseline + minimal CI)` → `M0.3-subtract (pure deletions: TerminalSecretStore, FALLBACK_MODELS, unused flags, parsers barrel, .gitignore)` → `M0.2 (characterization tests, --help golden, offline e2e, verify skill)` → `M0.1 (flat ESLint all workspaces, TS upgrade, Node matrix, invariant tests + ratchets)` → `M0.3-docs (rule rewrites, enforced by the new tests)` → `M0.4` → `M0.5`.

Why this order:
- Pure deletions are safe once a typecheck gate exists. They shrink the surface that M0.2 must pin, so they go before M0.2.
- The lint migration and TS upgrade are the riskiest toolchain changes. They come after tests exist, so behavior is pinned before the tools change.
- M0.4 (composition root) and M0.5 (defects) stay last as the plan says, since they need the pinned tests and the offline e2e.

### The first PR

**`chore: green baseline: reproducible install, typecheck gate, honest npm test, minimal CI`** (M0.0). Contents:

1. `git rm --cached packages/core/tsconfig.tsbuildinfo .claude/settings.local.json`. Add `*.tsbuildinfo` and `.claude/settings.local.json` to `.gitignore`. Remove `package-lock.json` from `.gitignore` and commit the lockfile.
2. Root `typecheck` script: `tsc -b packages/core packages/cli && tsc --noEmit -p desktop`. Delete the 4 stale `subtitle` props.
3. Make `packages/cli/bin/concilium.ts` read the version so it works from both `bin/` and `dist/bin/`.
4. One real smoke test each in core (for example `parseRankingFromText` on one known input) and desktop, and a CLI `test` script with a `--help` smoke test.
5. `.github/workflows/ci.yml`: `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint -w concilium`, `npm test` on Node 24. Pin actions by SHA.

Acceptance: from a fresh clone, `npm ci && npm run build && npm run typecheck && npm test && npm run dev -w @concilium/cli -- --help` all exit 0, and the PR shows a green CI run. Size: S–M (about 150 changed lines plus the lockfile). Skills: `principle-encode-lessons-in-structure`, `tdd`, `make-pr-easy-to-review`.

How it changes M0: it pulls the lockfile, untracking and basic CI out of M0.1 into a new M0.0, which also takes four fixes M0 didn't list (desktop types, CLI bin, smoke tests, buildinfo-as-blocker). M0.1 shrinks to the lint/TS/Node toolchain upgrade and moves after M0.2. Every later M0 acceptance check gets a red/green signal it does not have today.

## Appendix A. Repo-specific checks (rerun these)

```bash
# A.1 clean-clone build: core must emit declarations
npm ci && npm run build && find packages/core/dist -name '*.d.ts' | wc -l   # expect 34

# A.2 per-workspace typecheck (core declarations must exist first)
npx tsc -p packages/core --tsBuildInfoFile /tmp/core.tsbuildinfo
npx tsc --noEmit -p packages/cli
npx tsc --noEmit -p desktop

# A.3 license header ratchet
git ls-files -- 'packages/*.ts' 'packages/*.tsx' 'desktop/src/*.ts' 'desktop/src/*.tsx' \
  | xargs grep -L 'SPDX-License-Identifier: MIT' | wc -l                 # 85 today; may only go down

# A.4 console output in cli (rule is wrong for cli; tracked for the rewrite)
git ls-files 'packages/cli/src/*' | xargs grep -hE 'console\.(log|error)' | wc -l   # 79

# A.5 custom error classes thrown
git grep -nE 'new (ConciliumError|ConfigError|PipelineError|AgentError)\(' -- packages desktop   # 0

# A.6 documented commands vs real --help
node packages/cli/dist/bin/concilium.js --help    # compare with AGENTS.md:21, README, CHANGELOG

# A.7 CLI dev entry point
npm run dev -w @concilium/cli -- --help           # exit 1 today

# A.8 duplicate toolchain majors from floating installs
npm ls vite --all | grep -oE 'vite@[0-9.]+' | sort -u
```

## Appendix B. Evidence for the tsbuildinfo finding

1. Fresh `npm install`. `packages/core/dist` did not exist.
2. `npm run build`: core emitted 34 `.js` and 0 `.d.ts`, and `git status` showed ` M packages/core/tsconfig.tsbuildinfo`.
3. The same `tsc -p packages/core` with `--tsBuildInfoFile` pointing at a fresh file in `/tmp` emitted all 34 `.d.ts`.
4. The tracked buildinfo was last changed in `17a0178` ("fix: opencode image ingestion"). The likely mechanism (inferred, not traced) is incremental state from the author's machine that marks declaration output as up to date.
