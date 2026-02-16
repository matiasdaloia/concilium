# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.0] - 2026-02-16

### Added
- **Interactive Ink UI for `concilium run`**: Live-updating terminal UI with spinners, stage indicators, agent progress, juror status, leaderboard, and synthesis — replaces linear `console.log` output in TTY mode
- **Live token and cost tracking**: Per-agent and per-juror token counts displayed in real time during execution; full per-stage cost breakdown (agents, jurors, chairman) shown at completion
- **Markdown rendering in synthesis**: Chairman synthesis output rendered with terminal-native formatting (bold headers, code blocks, lists) via `marked` + `marked-terminal`
- **CI/CD documentation**: New "CI/CD and automation" section in CLI README covering `--json` mode, non-TTY fallback, `--quiet` mode, GitHub Actions example, and relevant environment variables

### Fixed
- **Agent name display**: Agents with no explicit model (e.g. OpenCode) no longer show a trailing `·` separator — displays just the provider name instead of `opencode · `
- **CostSummary layout**: Separator line and stats now render vertically (was horizontal due to missing `flexDirection="column"`)
- **Log pollution in interactive mode**: `INFO`/`DEBUG` logs from core services no longer corrupt the Ink UI — suppressed via `setLogLevel('error')` when Ink is active (unless `--verbose` is passed)

### Changed
- **Cost summary redesign**: Now shows a structured per-stage breakdown (Agents / Jurors / Chairman) with per-model token count and cost columns, plus a totals row
- **Ink upgraded to v6**: Moved from Ink 5 (React 18) to Ink 6 (React 19) to resolve `react-reconciler` compatibility crash

### Technical
- Exported `deliberationReducer`, `initialState`, and `Action` type from `useDeliberation.ts` for imperative use outside React
- Ink `render()` → `rerender()` pattern drives the UI from outside React, keeping components as a pure view layer
- Agent token accumulation respects `tokenUsageCumulative` flag (replace for cumulative events, sum for incremental)

## [2.0.0] - 2026-02-16

### Added
- **Monorepo architecture**: Extracted `@concilium/core` (domain logic) and `@concilium/cli` (terminal interface) from the desktop app into separate packages
- **Full CLI**: `concilium run`, `concilium history`, `concilium config`, `concilium models`, `concilium gui` commands with comprehensive flag support
- **Programmatic API**: `deliberate()` function exported from `@concilium/cli` for embedding in scripts, CI pipelines, and agent skills
- **Agent specification**: `--agents claude,codex,opencode` flag with optional model override (`claude:opus`)
- **Council customization**: `--juror-models`, `--jurors`, `--chairman` flags to override default juror and chairman models per run
- **Output formats**: `--json`, `--format md|plain`, `--output <file>` for flexible output handling
- **Run history**: `concilium history` with `--last`, `--synthesis`, `--json` flags
- **Configuration management**: `concilium config set|show|reset|path` with XDG Base Directory support
- **Model discovery**: `concilium models` discovers installed agent models; `--council` lists OpenRouter catalog
- **CLI documentation**: Comprehensive `packages/cli/README.md` with full command reference, flags, programmatic API, and architecture docs
- **Website CLI section**: Terminal mockup, command cards, and programmatic API showcase on the marketing site
- **Website Cloud waitlist**: "Concilium Cloud" section with email signup backed by Supabase, feature cards, and Hero teaser link
- **Website waitlist API**: Server-side `POST /api/waitlist` route (Astro hybrid output + Vercel adapter)
- **Navigation updates**: "CLI" and "Cloud" links added to website navigation

### Changed
- Repository restructured from single `desktop/` app to `packages/core` + `packages/cli` + `desktop/` monorepo
- README.md rewritten to cover both CLI and desktop workflows, updated repository structure, workspace-based development commands
- AGENTS.md updated with monorepo structure, hexagonal architecture guide, CLI patterns, environment variables, and website conventions
- Website switched from static output to hybrid output (`@astrojs/vercel` adapter) to support server-side API routes
- GetStarted section number bumped from 04 → 07 to accommodate new sections

### Technical
- Hexagonal (ports-and-adapters) architecture: `@concilium/core` defines port interfaces (`SecretStore`, `ConfigStore`, `RunRepository`, `DeliberationEvents`); CLI and desktop each provide their own adapters
- CLI built with Commander.js (commands) and Ink (React terminal UI)
- XDG Base Directory Specification for config (`~/.config/concilium/`), data (`~/.local/share/concilium/`), and cache paths
- Waitlist API uses plain `fetch()` against Supabase REST API (no `@supabase/supabase-js` dependency)

## [1.2.0] - 2026-02-08

### Added
- `concilium` CLI command — launch the GUI from any project directory (`concilium` or `concilium <path>`)
- `bin/concilium.js` entry point with `--help`, `--version`, path validation, and dev/prod detection
- `--cwd` flag support in Electron main process via `app.commandLine`
- `app:getCwd` IPC handler and `getCwd()` preload API for renderer access
- Project working directory displayed in HomeScreen action bar with folder icon
- `"bin"` field in `package.json` for `npm link` support
- CLI usage instructions in README.md (Step 4: "Run from anywhere")
- CLI-first "Run from anywhere" step on website GetStarted section

### Changed
- `registerIpcHandlers` now accepts a `projectCwd` parameter instead of calling `process.cwd()` directly
- Window title includes project directory basename (`Concilium — <dirname>`)
- README.md Development section now includes `npm link` / `concilium .` workflow
- Website Step 5 now features CLI as primary launch method with manual launch as alternative

## [1.1.0] - 2026-02-08

### Added
- Comprehensive analytics dashboard with per-run reports
- Per-juror and per-chairman timing metrics
- Estimated cost tracking for jurors and chairman with total cost overview
- Tooltips across the UI
- Analytics section on the marketing website

### Fixed
- Claude Code parser edge cases
- Website analytics showcase aligned with actual desktop app

### Changed
- Updated website `package-lock.json`

## [1.0.1] - 2026-02-07

### Added
- Interactive Before/After section on website showing workflow comparison
- Standardized container widths (`max-w-7xl`) across all sections
- Standardized vertical spacing (`py-24 md:py-32`) across all sections
- MIT License file
- Comprehensive README.md
- This CHANGELOG.md

### Changed
- Hero copy now leads with workflow pain point: "Every model gives you a different answer. Get the right one."
- Updated WhyItMatters to focus on concrete time savings (25 min → 3 min)
- Updated HowItWorks descriptions to emphasize what users don't have to do
- Navigation labels changed to be more user-friendly
- Demo section copy updated

### Removed
- Architecture "Under the Hood" section from website (too technical for landing page)
- "v1.0 Available Now" badge from hero
- Thematic/roleplay language ("Protocol", "Council is in Session", etc.)

## [1.0.0] - 2025-02-07

### Added
- Initial release of Concilium desktop application
- Multi-agent parallel execution (Claude, OpenAI, OpenCode)
- Three-stage consensus protocol (Execute → Review → Synthesize)
- Anonymous peer review system
- Synthesis engine for combining best responses
- Local-first architecture with Electron
- React-based UI with Tailwind CSS v4
- Marketing website built with Astro
- 3D animated hero section
- Interactive pipeline demo
- Open source release under MIT license

### Features
- Run multiple LLM agents simultaneously
- Watch responses stream in real-time
- Automatic blind peer review by juror models
- Consensus-based ranking system
- Final synthesis by Chairman model
- Persistent run history
- Agent management interface
- Dark theme UI with glassmorphism effects

### Technical
- Electron Forge for packaging
- Vite for fast development
- TypeScript throughout
- Three.js for 3D visuals
- React Three Fiber for React integration
- OpenRouter API integration
- Local JSON storage for runs and preferences

[Unreleased]: https://github.com/matiasdaloia/concilium/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/matiasdaloia/concilium/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/matiasdaloia/concilium/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/matiasdaloia/concilium/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/matiasdaloia/concilium/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/matiasdaloia/concilium/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/matiasdaloia/concilium/releases/tag/v1.0.0
