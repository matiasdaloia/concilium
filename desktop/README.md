# Concilium Desktop

Electron desktop application for the Concilium multi-LLM deliberation platform. Provides a graphical interface for running deliberations, viewing agent outputs in real time, and browsing history.

## Prerequisites

- Node.js 22+
- macOS 12+ (Apple Silicon or Intel) or Linux
- An [OpenRouter](https://openrouter.ai/) API key
- At least one coding agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)
  - [Codex](https://github.com/openai/codex) (OpenAI)
  - [OpenCode](https://github.com/sst/opencode)

## Getting started

From the **monorepo root**:

```bash
# 1. Install all workspace dependencies
npm install

# 2. Set your OpenRouter API key
echo "OPENROUTER_API_KEY=sk-or-..." > desktop/.env

# 3. Start the Electron dev server
npm run start -w concilium
```

The app will open with hot-reload enabled for the renderer process.

## Available scripts

All commands are run from the monorepo root using `-w concilium`:

| Command | Description |
|---------|-------------|
| `npm run start -w concilium` | Start in development mode (hot-reload) |
| `npm run package -w concilium` | Package the app for the current platform |
| `npm run make -w concilium` | Create distributable installers |
| `npm run lint -w concilium` | Run ESLint |
| `npm run test -w concilium` | Run tests (Vitest) |
| `npm run test:watch -w concilium` | Run tests in watch mode |
| `npm run smoke -w concilium` | Start the packaged app under `xvfb-run` with `--smoke-test` and quit (Linux); add `-- --open-run <run-dir>` to also open a code run and print its ranking |

## Code runs

**Open run** on the home screen opens a run directory that `concilium code` wrote (by default under `~/.local/share/concilium/runs/<run-id>`), read-only: the ranking, the candidates, the survival matrix, the dissent, the synthesis, the verdict from `concilium verify-pr` when there is one, the decision trail and the markdown reports. Start the app with `--open-run <run-dir>` to open one at once. The desktop reads only `run.json`, `synthesis.md`, `dissent.json`, `decisions.tsv`, `verification.md` and `reframe.md` inside that directory, and never starts a code run itself. A file it cannot read, or a record newer than it knows, is listed as a note above the run.

## Project structure

```
desktop/
├── src/
│   ├── main/              # Electron main process
│   │   ├── main.ts        # App entry point
│   │   ├── ipc.ts         # IPC handler registration
│   │   ├── run-dir.ts     # Reads a code-run directory (run-view.ts parses it)
│   │   ├── services/      # Process spawning, CLI parsers, runner
│   │   └── adapters/      # Electron-specific port implementations
│   ├── preload/           # Preload scripts (contextBridge)
│   ├── shared/            # Types shared by main and renderer (RunView)
│   └── renderer/          # React frontend
│       ├── App.tsx        # Root component and routing
│       ├── screens/       # Page-level components
│       ├── components/    # Reusable UI components
│       ├── hooks/         # Custom hooks (useCouncilRun, etc.)
│       └── utils/         # Frontend utilities
├── .env                   # Local environment variables (not committed)
└── package.json
```

## Environment variables

Create a `.env` file in the `desktop/` directory:

```bash
OPENROUTER_API_KEY=sk-or-...
```

Alternatively, set `OPENROUTER_API_KEY` as a system environment variable — it takes priority everywhere.

## Architecture

The desktop app is a thin shell over `@concilium/core`. It provides Electron-specific adapter implementations for the core's port interfaces:

| Port | Desktop adapter |
|------|-----------------|
| `SecretStore` | `ElectronSecretStore` (OS keychain via `safeStorage`) |
| `ConfigStore` | `JsonConfigStore` (Electron `userData` directory) |
| `RunRepository` | `JsonRunRepository` (Electron `userData` directory) |
| `DeliberationEvents` | IPC event bridge (`webContents.send`) |

The main process spawns coding agents (Claude, Codex, OpenCode) as child processes, parses their JSON stdout into `ParsedEvent`s, and sends them to the renderer via IPC. The renderer consumes these events through the `useCouncilRun` hook to drive the live UI.

## Voice dictation

The desktop app includes offline voice dictation powered by [Whisper](https://github.com/openai/whisper). See the [root README](../README.md#voice-dictation) for setup instructions.
