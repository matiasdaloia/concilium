# Concilium

> Every model gives you a different answer. Get the right one.

Concilium is a multi-LLM deliberation platform that runs multiple AI coding agents in parallel, has them peer-review each other's responses anonymously, and synthesizes a single superior answer — all in one desktop application.

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
- **Local-First** — Your data stays on your machine
- **Single Interface** — No more tab switching or terminal juggling
- **Open Source** — MIT licensed, fully transparent

## Installation

### macOS

```bash
brew install --cask concilium
```

Or download the latest release from the [Releases page](https://github.com/matiasdaloia/concilium/releases).

### Linux

Download the latest `.AppImage` or `.deb` from the [Releases page](https://github.com/matiasdaloia/concilium/releases).

### Requirements

- macOS 12+ or Linux
- At least one CLI agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)
  - [Codex](https://github.com/openai/codex) (OpenAI)
  - [OpenCode](https://github.com/sst/opencode) or similar
- OpenRouter API key (for peer review and synthesis stages)

## Quick Start

1. **Download and install** Concilium
2. **Configure your agents** in the app settings
3. **Add your OpenRouter API key** for the review stage
4. **Ask a question** and watch the council deliberate

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
llm-council/
├── desktop/          # Electron desktop application
│   ├── src/
│   │   ├── main/     # Main process (Node.js)
│   │   ├── preload/  # Preload scripts
│   │   └── renderer/ # React frontend
│   └── package.json
├── website/          # Astro marketing website
│   ├── src/
│   │   ├── sections/ # Page sections
│   │   ├── islands/  # Interactive React components
│   │   └── layouts/  # Page layouts
│   └── package.json
└── assets/           # Shared assets (logos, icons)
```

## Development

### Desktop App

```bash
cd desktop
npm install
npm run start        # Start development server
npm run package      # Package the app
npm run make         # Create distributables
npm run test         # Run tests
```

### Website

```bash
cd website
npm install
npm run dev          # Start development server
npm run build        # Build for production
npm run preview      # Preview production build
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
- Website powered by [Astro](https://astro.build/) and [Tailwind CSS](https://tailwindcss.com/)
- 3D visuals using [React Three Fiber](https://docs.pmnd.rs/react-three-fiber)

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/matiasdaloia">Matias Daloia</a>
</p>
