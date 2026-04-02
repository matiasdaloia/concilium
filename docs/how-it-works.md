# How It Works

Concilium uses a 3-stage adversarial consensus pipeline to produce code reviews that are deeper and more reliable than any single AI model.

## The Problem with Single-Model Reviews

Every AI model has blind spots. Claude might miss a race condition that GPT catches. Gemini might flag a security issue both others miss. Running one model gives you one perspective — and no way to know what it missed.

Concilium's approach: **run multiple models, make them challenge each other, quantify their agreement.**

## The 3-Stage Pipeline

```
┌─────────────────────────────────────────────────────┐
│  STAGE 1: COMPETE                                    │
│  3 AI agents review your code independently          │
│  Each has full read access to your codebase          │
│  Different models → different perspectives           │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  STAGE 2: JUDGE                                      │
│  Juror models evaluate all 3 reviews blindly         │
│  Reviews labeled A, B, C — no model names shown      │
│  Each juror produces an independent ranking          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  STAGE 3: SYNTHESIZE                                 │
│  Chairman model merges the best findings             │
│  Resolves disagreements with its own judgment        │
│  Produces one cohesive review                        │
└─────────────────────────────────────────────────────┘
                        ↓
            Confidence Score + Verdict
```

### Stage 1: Compete

Three instances of [OpenCode](https://opencode.ai) run in parallel, each powered by a **different AI model** via [OpenRouter](https://openrouter.ai). Each agent:

- Reads the PR diff
- Explores relevant files in the repository (imports, types, tests)
- Produces an independent code review

Because they're different models, they catch different things. One might focus on security, another on logic errors, a third on architectural patterns.

**Key difference from other tools:** Agents have **full filesystem access** to your codebase. They don't just see the diff — they can read the files that changed, trace imports, check type definitions, and understand the surrounding architecture. This is why Concilium catches issues that diff-only tools miss.

### Stage 2: Judge

Multiple juror models evaluate all three reviews **anonymously**. Reviews are labeled Response A, Response B, Response C — jurors don't know which model wrote which review.

Each juror ranks the reviews on:
- **Correctness** — Are the findings actually bugs?
- **Completeness** — Did it cover all changed files and edge cases?
- **Code quality** — Are the suggestions actionable and specific?
- **Architecture** — Does it understand the broader system design?
- **Risk awareness** — Are security, performance, and regression risks flagged?

### Stage 3: Synthesize

A chairman model receives all three reviews plus all juror evaluations, then produces a single synthesized review that:

- Takes the strongest findings from the top-ranked reviews
- Resolves disagreements between reviewers
- Drops false positives that jurors identified as incorrect
- Presents findings as a single cohesive review

## Confidence Scoring

Concilium doesn't just give you a review — it tells you **how confident you should be** in the result.

### How It's Calculated

The confidence score (0–100) is based on **juror agreement** measured by [Kendall tau distance](https://en.wikipedia.org/wiki/Kendall_tau_distance):

- **100%** — All jurors agree on the exact same ranking
- **~70%** — Jurors mostly agree with minor differences
- **~40%** — Significant disagreement on quality
- **0%** — No jurors produced valid rankings (pipeline failure)

### Disagreement Detection

When a juror's ranking of an agent differs from the median by more than 1 position, it's flagged as a **disagreement**. This surfaces cases where the review quality is contested.

```
Disagreements:
  - agent-1: juror gemini ranked #3 (median: 1, delta: 2.0)
  - agent-3: juror gpt ranked #1 (median: 2.5, delta: 1.5)
```

### Verdict

The verdict is simple:
- **PASS** — confidence score ≥ threshold (default: 70)
- **FAIL** — confidence score < threshold

In CI, PASS exits with code 0 (check passes), FAIL exits with code 1 (check fails).

## Architecture

Concilium uses a **hexagonal (ports-and-adapters) architecture**:

```
┌──────────────────────────────────────────────────────┐
│                    @concilium/core                    │
│                                                      │
│  Domain          Services           Ports            │
│  ├── Agent       ├── Deliberation   ├── AgentProvider│
│  ├── Council     ├── Config         ├── LlmGateway   │
│  ├── Run         ├── TierGate       ├── GithubGateway│
│  └── Deliberation├── ContextDiscovery├── ConfigStore  │
│                  └── ModelDiscovery  └── SecretStore  │
└──────────────────────────┬───────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ↓            ↓            ↓
         @concilium/cli  desktop/    website/
         (Terminal)      (Electron)  (Astro)
```

The core is framework-agnostic. The CLI, desktop app, and website are thin shells that provide their own adapter implementations.

## Agent Runtime: OpenCode + OpenRouter

Rather than requiring three separate AI tool installations, Concilium uses a single runtime:

- **[OpenCode](https://opencode.ai)** — A Go-based CLI that gives AI models read access to your codebase (read files, grep, glob, web search)
- **[OpenRouter](https://openrouter.ai)** — A unified API that provides access to 400+ AI models through a single endpoint

This means:
- **One CLI** to install (OpenCode)
- **One API key** to configure (OpenRouter)
- **Any model** available — different models for agents, jurors, and chairman
- **Full codebase access** — agents explore your code, not just the diff

## Context Discovery

Before running agents, Concilium scans your repository for convention files and injects them into the review prompt. See [Configuration](configuration.md) for details.

Discovered content includes:
- Review guidelines (`.concilium/review.md`, `AGENTS.md`)
- Focus areas (`.concilium/focus.md`)
- MCP server connections (`.concilium/mcp.json`)
- Project stack (detected from `package.json`, `go.mod`, etc.)
