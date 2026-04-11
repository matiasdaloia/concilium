# Concilium

> The peer-review step your AI pipeline is missing.

Concilium runs multiple AI agents on your code, has them peer-review each other blindly, and gives you a confidence-scored verdict. Use it as a **GitHub Action**, **CLI command**, or **programmatic API**.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](https://github.com/matiasdaloia/concilium)
[![Linux](https://img.shields.io/badge/platform-Linux-lightgrey.svg)](https://github.com/matiasdaloia/concilium)

## Why Concilium?

AI-generated code ships with bugs no single model catches. Diff-only review tools score [1/5 on completeness](https://ucstrategies.com/news/coderabbit-review-2026-fast-ai-code-reviews-but-a-critical-gap-enterprises-cant-ignore/). Concilium is different:

- **Agents read your codebase** — not just the diff. They trace imports, check types, find missing tests.
- **3 models review independently** — different models catch different bugs.
- **Blind peer review** — juror models rank reviews anonymously. No bias.
- **Confidence-scored verdict** — PASS/FAIL with a quantified agreement score, not just line comments.
- **Local-first** — code never leaves your machine. Open source. MIT licensed.
- **One API key** — [OpenRouter](https://openrouter.ai) gives you access to 400+ models.

## Quick Start

### GitHub Action (recommended)

```yaml
# .github/workflows/concilium.yml
name: Concilium Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: matiasdaloia/concilium-action@v1
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

One secret. That's it.

### CLI

```bash
# Install
npm install -g @concilium/cli
curl -fsSL https://opencode.ai/install | bash

# Configure
concilium config set api-key sk-or-v1-...

# Review a PR
concilium verify --pr https://github.com/org/repo/pull/42
```

### Programmatic API

```typescript
import { deliberate } from '@concilium/cli';

const result = await deliberate({
  prompt: 'Add rate limiting to the API endpoints',
  agents: [
    { provider: 'opencode', model: 'anthropic/claude-sonnet-4.5' },
    { provider: 'opencode', model: 'openai/gpt-5.2' },
  ],
});

console.log(result.stage3?.response);
```

## How It Works

```
PR opened → 3 agents review code (full filesystem access)
         → Juror models rank reviews blindly
         → Chairman synthesizes best findings
         → Confidence score + PASS/FAIL verdict
         → Posted as PR comment
```

**Stage 1 — Compete:** Three [OpenCode](https://opencode.ai) instances run in parallel, each powered by a different AI model via OpenRouter. Each reads your codebase, explores imports, checks tests, and produces an independent review.

**Stage 2 — Judge:** Juror models evaluate all three reviews anonymously (labeled A, B, C — no model names). Each juror ranks reviews on correctness, completeness, and risk awareness.

**Stage 3 — Synthesize:** A chairman model merges the strongest findings, resolves disagreements, and produces one cohesive review with a confidence score.

## Customize Reviews

Drop a `.concilium/review.md` in your repo and agents follow your standards automatically:

```markdown
# Code Review Standards

## Security
- All user input MUST be validated with zod schemas
- SQL queries MUST use parameterized queries
- API endpoints MUST check authentication

## Architecture
- Follow hexagonal architecture: domain in src/domain/, adapters in src/adapters/
- Database access MUST go through repository interfaces
```

Concilium also auto-discovers `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, and other convention files. See [Configuration docs](docs/configuration.md).

### MCP Server Integration

Connect security scanners and analysis tools via `.concilium/mcp.json`:

```json
{
  "servers": {
    "snyk": { "url": "https://mcp.snyk.io", "env": { "SNYK_TOKEN": "${SNYK_TOKEN}" } },
    "semgrep": { "command": "semgrep-mcp", "args": ["--stdio"] }
  }
}
```

Agents can use these tools during review — Snyk for vulnerabilities, Semgrep for custom rules, SonarQube for code quality.

## Model Presets

Choose a preset or bring your own models:

| Preset | Models | Cost per PR |
|--------|--------|-------------|
| `--preset fast` (default) | Gemini Flash, DeepSeek, Llama | Free |
| `--preset balanced` | Claude Sonnet, GPT-5, Gemini Pro | ~$0.03 |
| `--preset thorough` | Claude Opus, GPT-5, Gemini Pro | ~$0.10 |
| `--models <custom>` | Whatever you want | Depends on models |

Open source. Bring your own [OpenRouter](https://openrouter.ai) key. You pay only for the models you choose — Concilium takes no markup.

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Install, configure, first review in 5 minutes |
| [CI/CD Integration](docs/ci-cd.md) | GitHub Action setup and workflow examples |
| [CLI Reference](docs/cli-reference.md) | All commands, flags, exit codes |
| [Configuration](docs/configuration.md) | Review guidelines, MCP servers, convention files |
| [How It Works](docs/how-it-works.md) | The 3-stage pipeline and confidence scoring |
| [Programmatic API](docs/api.md) | Embed in scripts and CI pipelines |

## Repository Structure

```
concilium/
├── packages/
│   ├── core/              # @concilium/core — domain logic, ports, adapters
│   ├── cli/               # @concilium/cli — terminal interface
│   └── github-action/     # GitHub Action definition
├── desktop/               # Electron desktop application
├── website/               # Astro marketing website
└── docs/                  # User-facing documentation
```

**Architecture:** Hexagonal (ports-and-adapters). `@concilium/core` contains all domain logic and is framework-agnostic. CLI, desktop, and GitHub Action are thin shells with their own adapters.

## Development

```bash
git clone https://github.com/matiasdaloia/concilium.git
cd concilium
npm install
npm run build          # Build core + CLI

# Dev mode (no build needed)
npm run dev -w @concilium/cli -- run "your prompt"

# Run tests
npm test               # All workspaces

# Desktop app
npm run start -w concilium

# Website
npm run dev -w concilium-website
```

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">
  Made by <a href="https://github.com/matiasdaloia">Matias Daloia</a>
</p>
