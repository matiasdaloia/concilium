# Concilium

> Every model gives you a different answer. Get the right one.

Concilium is a multi-LLM deliberation platform that runs multiple AI coding agents in parallel, has them peer-review each other's responses anonymously, and synthesizes a single superior answer — from the terminal or as a desktop application.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](https://github.com/matiasdaloia/concilium)
[![Linux](https://img.shields.io/badge/platform-Linux-lightgrey.svg)](https://github.com/matiasdaloia/concilium)

![Concilium Screenshot](assets/concilium-screenshot.png)

## The Problem

You already know one model isn't enough. So you open multiple terminals, paste the same prompt into Claude, OpenAI, and Codex, then spend 20 minutes reading and comparing their outputs. There has to be a better way.

**The old workflow:**
- Copy-paste the same prompt into 3 different tools
- Switch between browser tabs, terminals, and apps
- Read 3 long outputs and compare them manually
- Hope you picked the answer with the fewest bugs

**~25 minutes per prompt. High cognitive load. Error-prone.**

## The Solution

Concilium automates the entire process:

1. **Parallel Execution** — Send one prompt, three agents start working simultaneously
2. **Blind Peer Review** — Juror models evaluate and rank responses anonymously
3. **Synthesis** — A Chairman model combines the best parts into one validated answer

**~3 minutes per prompt. Fully automated. Peer-validated.**

## Features

- **Multi-Agent Execution** — Run Claude, OpenAI, and local models in parallel
- **Anonymous Peer Review** — Models critique each other without bias
- **Consensus-Based Ranking** — Objective scoring filters out hallucinations
- **Synthesized Output** — One answer that captures the best of all three
- **CLI and Desktop** — Full terminal interface or Electron GUI, your choice
- **Programmatic API** — `import { deliberate } from '@concilium/cli'` for agent skills and scripts
- **Local-First** — Your data stays on your machine
- **Open Source** — MIT licensed, fully transparent

## Getting Started

### Prerequisites

- Node.js 18+
- macOS 12+ (Apple Silicon or Intel) or Linux
- An [OpenRouter](https://openrouter.ai/) API key (for jurors and synthesis)
- At least one coding agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)
  - [Codex](https://github.com/openai/codex) (OpenAI)
  - [OpenCode](https://github.com/sst/opencode)

### 1. Clone and install

```bash
git clone https://github.com/matiasdaloia/concilium.git
cd concilium
npm install
```

### 2. Configure your API key

**CLI:**
```bash
concilium config set api-key sk-or-...
```

**Desktop (alternative):** Create a `.env` file in the `desktop/` directory:
```bash
echo "OPENROUTER_API_KEY=sk-or-..." > desktop/.env
```

Or set `OPENROUTER_API_KEY` as an environment variable — it takes priority everywhere.

### 3. Run a deliberation

**From the terminal (CLI):**

```bash
concilium run "Refactor the auth module to use JWT tokens"
```

**With the desktop GUI:**

```bash
concilium gui                  # opens the Electron app in the current directory
concilium gui ./my-project     # or specify a project path
```

> See the [CLI documentation](packages/cli/README.md) for the full command reference.

## CLI

Concilium ships a full-featured terminal interface alongside the desktop app. Run deliberations, manage configuration, browse history, and discover models — all from the command line.

### Quick examples

```bash
# Basic deliberation
concilium run "Add input validation to the user registration endpoint"

# Read prompt from a file
concilium run -f prompt.md

# Pick specific agents and models
concilium run --agents claude,codex,opencode "Fix the race condition in the worker pool"

# Custom juror models and chairman
concilium run --juror-models anthropic/claude-sonnet-4,openai/gpt-4.1 \
              --chairman anthropic/claude-sonnet-4 \
              "Design a rate limiter"

# JSON output for scripting
concilium run --json "Explain the auth flow" | jq '.stage3.response'

# Save synthesis to a file
concilium run --output solution.md "Migrate the database schema"

# Stage 1 only (skip council review)
concilium run --stage1-only "Generate test fixtures"
```

### Commands

| Command | Description |
|---------|-------------|
| `concilium run <prompt>` | Run a deliberation pipeline |
| `concilium history` | List past runs |
| `concilium history <id>` | View a specific run |
| `concilium history --last --synthesis` | Print the last synthesis |
| `concilium config show` | Show current configuration |
| `concilium config set api-key` | Set your OpenRouter API key |
| `concilium config set chairman <model>` | Set the chairman model |
| `concilium config set jurors <m1,m2,...>` | Set juror models |
| `concilium models` | Discover available agent models |
| `concilium models --council` | List OpenRouter models for jurors |
| `concilium gui [path]` | Launch the desktop GUI |

For detailed usage, flags, configuration, and the programmatic API, see the **[CLI documentation](packages/cli/README.md)**.

## Architecture

Concilium uses a three-stage consensus protocol:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Stage 1:       │     │  Stage 2:       │     │  Stage 3:       │
│  Parallel       │ ──► │  Blind          │ ──► │  Synthesis      │
│  Execution      │     │  Review         │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
   ┌─────────┐            ┌─────────┐            ┌─────────┐
   │ Claude  │            │ Juror 1 │            │         │
   │ OpenAI   │            │ Juror 2 │            │ Chairman│
   │ OpenCode│            │ Juror N │            │         │
   └─────────┘            └─────────┘            └─────────┘
        │                       │                       │
        └───────────────────────┴───────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  Final Answer   │
                    │  (Validated)    │
                    └─────────────────┘
```

## Repository Structure

```
concilium/
├── packages/
│   ├── core/             # @concilium/core — domain logic, ports, adapters
│   │   ├── src/
│   │   │   ├── domain/   # Agent, council, deliberation, run types & logic
│   │   │   ├── ports/    # Interfaces (AgentProvider, LlmGateway, etc.)
│   │   │   ├── adapters/ # OpenRouter, Claude, Codex, OpenCode, JSON storage
│   │   │   ├── services/ # DeliberationService, ConfigService
│   │   │   └── shared/   # Logger, error types
│   │   └── package.json
│   └── cli/              # @concilium/cli — terminal interface
│       ├── bin/          # Entry point (concilium command)
│       ├── src/
│       │   ├── commands/ # run, history, config, models, gui
│       │   ├── ui/       # Ink (React) terminal components
│       │   ├── adapters/ # XDG paths, terminal secret store
│       │   └── formatters/
│       └── package.json
├── desktop/              # Electron desktop application
│   ├── src/
│   │   ├── main/         # Main process + Electron-specific adapters
│   │   ├── preload/      # Preload scripts
│   │   └── renderer/     # React frontend
│   └── package.json
├── website/              # Astro marketing website
└── assets/               # Shared assets (logos, icons)
```

## Voice Dictation

Concilium includes offline voice dictation powered by [Whisper](https://github.com/openai/whisper). Speak your prompts instead of typing them.

### Setup

Voice dictation requires a one-time setup to download the Whisper model and build the binary:

```bash
cd desktop

# Download the Whisper model (~150MB)
npx nodejs-whisper download

# Build whisper.cpp
cd node_modules/nodejs-whisper/cpp/whisper.cpp
cmake -B build -DGGML_CUDA=OFF
cmake --build build --config Release
```

### Requirements

- **ffmpeg** (recommended): For audio format conversion
  ```bash
  # macOS
  brew install ffmpeg
  
  # Ubuntu/Debian
  sudo apt install ffmpeg
  ```

### Usage

1. Click the **Dictate** button next to the prompt input
2. Speak your prompt
3. Click **Stop** when finished
4. Wait 2-3 seconds for transcription
5. Your text appears in the prompt field

Voice dictation runs **completely offline** — your audio never leaves your machine.

## Development

All packages are managed as an npm workspace from the repo root.

```bash
npm install          # Install all workspace dependencies
```

### CLI

```bash
npx concilium run "your prompt"         # Run via workspace
npm run dev -w @concilium/cli           # Dev mode with tsx
npm run build -w @concilium/core        # Build core first
npm run build -w @concilium/cli         # Then build CLI
```

### Desktop App

```bash
npm run start -w concilium              # Start Electron dev server
npm run package -w concilium            # Package the app
npm run make -w concilium               # Create distributables
npm run test -w concilium               # Run desktop tests
```

### Website

```bash
npm run dev -w website                  # Start dev server
npm run build -w website                # Build for production
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Electron](https://www.electronjs.org/), [React](https://react.dev/), and [TypeScript](https://www.typescriptlang.org/)
- CLI powered by [Commander.js](https://github.com/tj/commander.js) and [Ink](https://github.com/vadimdemedes/ink) (React for terminals)
- LLM routing via [OpenRouter](https://openrouter.ai/)
- Website powered by [Astro](https://astro.build/) and [Tailwind CSS](https://tailwindcss.com/)
- 3D visuals using [React Three Fiber](https://docs.pmnd.rs/react-three-fiber)

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/matiasdaloia">Matias Daloia</a>
</p>
