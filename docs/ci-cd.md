# CI/CD Integration

Add multi-agent code review to every pull request with a single GitHub Action.

## GitHub Action

### Minimal Setup

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

**Required secrets:**
- `OPENROUTER_API_KEY` — Your [OpenRouter API key](https://openrouter.ai/keys)

That's it. The action will:
1. Install OpenCode and Concilium CLI on the runner
2. Discover your repo's review guidelines automatically
3. Run 3 agents with different AI models on the PR diff
4. Post a confidence-scored review comment on the PR
5. Pass or fail the check based on confidence threshold

### Full Configuration

```yaml
- uses: matiasdaloia/concilium-action@v1
  with:
    # Required
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}

    # Optional
    threshold: '70'              # Confidence threshold for PASS/FAIL (0-100)
    preset: 'fast'               # Model preset: fast, balanced, thorough
    models: ''                   # Override models (comma-separated OpenRouter IDs)
    fail-on-low-confidence: 'true'  # Fail the GitHub check on FAIL verdict
    no-post: 'false'             # Skip posting review comment
    focus-files: ''              # Comma-separated files to focus on
    custom-instructions: ''      # Extra review instructions
    github-token: ${{ github.token }}  # For posting comments (auto-provided)
```

### Action Outputs

```yaml
- uses: matiasdaloia/concilium-action@v1
  id: review
  with:
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}

- run: echo "Verdict: ${{ steps.review.outputs.verdict }}"
- run: echo "Confidence: ${{ steps.review.outputs.confidence }}%"
```

| Output | Description |
|--------|-------------|
| `verdict` | `PASS` or `FAIL` |
| `confidence` | Confidence score (0-100) |

## Workflow Examples

### Only review critical files

```yaml
- uses: matiasdaloia/concilium-action@v1
  with:
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    focus-files: 'src/auth/,src/payments/,infrastructure/'
    threshold: '80'
```

### Use stronger models for better accuracy

```yaml
- uses: matiasdaloia/concilium-action@v1
  with:
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    preset: 'balanced'
    threshold: '75'
```

### Non-blocking review (always passes)

```yaml
- uses: matiasdaloia/concilium-action@v1
  with:
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    fail-on-low-confidence: 'false'
```

### Conditional review (only on labeled PRs)

```yaml
on:
  pull_request:
    types: [opened, synchronize, labeled]

jobs:
  review:
    if: contains(github.event.pull_request.labels.*.name, 'needs-review')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: matiasdaloia/concilium-action@v1
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

### Custom models

```yaml
- uses: matiasdaloia/concilium-action@v1
  with:
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
    models: 'anthropic/claude-sonnet-4.5,openai/gpt-5.2,google/gemini-3-pro-preview'
```

## How It Works in CI

```
PR opened/updated
    ↓
GitHub Action triggers
    ↓
actions/checkout — gets the full repo on the runner
    ↓
Install OpenCode + Concilium CLI
    ↓
concilium verify --pr <url> --format json
    ├── Discover context (.concilium/review.md, AGENTS.md, etc.)
    ├── Fetch PR diff from GitHub API
    ├── Run 3 OpenCode instances in parallel (different models)
    │   └── Each agent has full filesystem access to the repo
    ├── Juror models rank agent reviews blindly
    ├── Chairman synthesizes findings
    └── Output: confidence score + verdict
    ↓
Post review comment on PR
    ↓
Pass/fail the GitHub check
```

**Key advantage:** Unlike diff-only review tools, Concilium agents have **full read access to your codebase**. They can trace imports, read type definitions, check test coverage, and understand architectural context — not just the lines that changed.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | PASS — confidence meets or exceeds threshold |
| `1` | FAIL — confidence below threshold |
| `2` | Error — pipeline failure, missing config, API error |

## Cost Estimates

With the `fast` preset, a typical PR review costs **$0.00** (free models via OpenRouter). With `balanced` or `thorough`, expect **$0.01–0.10** per review depending on PR size and models chosen.
