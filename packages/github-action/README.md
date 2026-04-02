# Concilium Verify — GitHub Action

Run multi-agent deliberation on pull requests. Get a confidence-scored code review powered by AI consensus.

## Quick Start

```yaml
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
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `github-token` | Yes | — | GitHub token for API access |
| `openrouter-api-key` | Yes | — | OpenRouter API key for juror/chairman models |
| `threshold` | No | `70` | Confidence threshold (0-100) for PASS/FAIL |
| `agents` | No | — | Agents to use (e.g. `claude,codex,opencode`) |
| `preset` | No | `fast` | Model preset: `fast`, `balanced`, or `thorough` |
| `fail-on-low-confidence` | No | `true` | Fail the check when verdict is FAIL |
| `no-post` | No | `false` | Skip posting review comment |
| `focus-files` | No | — | Comma-separated files to focus on |
| `custom-instructions` | No | — | Additional review instructions |

## Outputs

| Output | Description |
|--------|-------------|
| `verdict` | `PASS` or `FAIL` |
| `confidence` | Confidence score (0-100) |
| `report-url` | URL of the posted review comment |

## How It Works

1. Fetches the PR diff via GitHub API
2. Runs multiple AI agents in parallel to review the code
3. Has juror models blindly rank the agent reviews
4. Synthesizes the best insights into one review
5. Posts the review as a PR comment with confidence score
6. Passes or fails the GitHub check based on confidence threshold
