# Concilium Documentation

> The peer-review step your AI pipeline is missing.

Concilium runs multiple AI agents on your code, has them peer-review each other blindly, and gives you a confidence-scored verdict. Use it as a GitHub Action, CLI command, or programmatic API.

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](getting-started.md) | Install, configure, run your first review in 5 minutes |
| [CI/CD Integration](ci-cd.md) | GitHub Action setup, workflow examples, CI best practices |
| [CLI Reference](cli-reference.md) | All commands, flags, and output formats |
| [Configuration](configuration.md) | `.concilium/` directory, review guidelines, MCP servers, convention files |
| [How It Works](how-it-works.md) | Architecture, the 3-stage pipeline, confidence scoring |
| [Programmatic API](api.md) | Embed Concilium in scripts, CI pipelines, and agent skills |

## Quick Start

```bash
# Install
npm install -g @concilium/cli
curl -fsSL https://opencode.ai/install | bash

# Configure
concilium config set api-key sk-or-v1-...    # Your OpenRouter API key

# Review a PR
concilium verify --pr https://github.com/org/repo/pull/42
```

Or add to any GitHub repo:

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
