# Getting Started

Get Concilium running in 5 minutes.

## Prerequisites

- **Node.js 18+** — [Install](https://nodejs.org/)
- **OpenRouter API key** — [Get one free](https://openrouter.ai/keys) (no credit card required for free-tier models)

## Install

### 1. Install the Concilium CLI

```bash
npm install -g @concilium/cli
```

### 2. Install OpenCode

Concilium uses [OpenCode](https://opencode.ai) as its agent runtime. OpenCode is a single Go binary that gives AI models full read access to your codebase.

```bash
curl -fsSL https://opencode.ai/install | bash
```

### 3. Configure your API key

```bash
concilium config set api-key sk-or-v1-...
```

This stores your OpenRouter key locally. It's used for both the review agents and the juror/chairman models.

> **Tip:** In CI, set the `OPENROUTER_API_KEY` environment variable instead.

## Your First Review

### Option A: Review a GitHub PR

```bash
concilium verify --pr https://github.com/your-org/your-repo/pull/42
```

This will:
1. Fetch the PR diff from GitHub
2. Scan your repo for review guidelines (AGENTS.md, .concilium/review.md, etc.)
3. Run 3 AI agents in parallel, each reviewing with full codebase access
4. Have juror models rank the reviews blindly
5. Synthesize findings and output a confidence-scored verdict

### Option B: Run a general deliberation

```bash
concilium run "Add rate limiting to the API endpoints"
```

This runs the full 3-stage pipeline (Compete → Judge → Synthesize) for any coding task.

## What You'll See

```
Discovering project context...
  Found: AGENTS.md
PR: org/repo#42 — Fix authentication bypass
  3 files changed (+45 -12)
Running 3 agents: google/gemini-2.5-flash, deepseek/deepseek-chat-v3, meta-llama/llama-4-maverick
[Stage 1] Parallel Execution
  Agent opencode-a1b2: running
  Agent opencode-c3d4: running
  Agent opencode-e5f6: running
  Agent opencode-a1b2: success
  Agent opencode-c3d4: success
  Agent opencode-e5f6: success
[Stage 2] Blind Peer Review
[Stage 3] Synthesis

Verdict: PASS (confidence: 87%, threshold: 70%)
```

## Next Steps

- [Set up the GitHub Action](ci-cd.md) for automatic PR reviews
- [Add review guidelines](configuration.md) to customize what agents look for
- [Explore the CLI](cli-reference.md) for all commands and options
- [Understand how it works](how-it-works.md) — the 3-stage pipeline and confidence scoring
