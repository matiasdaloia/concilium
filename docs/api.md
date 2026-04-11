# Programmatic API

Embed Concilium in scripts, CI pipelines, or agent skills with a single function call.

## Installation

```bash
npm install @concilium/cli
```

## `deliberate()` — General Deliberation

```typescript
import { deliberate } from '@concilium/cli';

const result = await deliberate({
  prompt: 'Add error handling to the payment service',
  agents: [
    { provider: 'opencode', model: 'anthropic/claude-sonnet-4.5' },
    { provider: 'opencode', model: 'openai/gpt-5.2' },
  ],
  apiKey: process.env.OPENROUTER_API_KEY,
  cwd: '/path/to/project',
});

console.log(result.stage3?.response);  // Synthesized answer
console.log(result.metadata.aggregateRankings);  // Agent rankings
```

### Options

```typescript
interface ConciliumOptions {
  prompt: string;
  cwd?: string;                    // Working directory (default: process.cwd())
  agents?: Array<{
    provider: string;              // 'opencode', 'claude', 'codex'
    model?: string;                // OpenRouter model ID
  }>;
  councilModels?: string[];        // Override juror models
  chairmanModel?: string;          // Override chairman model
  apiKey?: string;                 // OpenRouter API key
  onProgress?: EventHandler;       // Event callbacks
  save?: boolean;                  // Persist to history (default: true)
}
```

### Return Type

```typescript
interface RunRecord {
  id: string;
  createdAt: string;
  prompt: string;
  cwd: string;
  agents: AgentResult[];          // All agent outputs
  stage1: Stage1Result[];         // Successful agent plans
  stage2: Stage2Result[];         // Juror rankings
  stage3: Stage3Result | null;    // Synthesized answer
  metadata: RunMetadata;          // Rankings, costs, timing
  mode?: 'run' | 'verify';
  verdict?: 'PASS' | 'FAIL';
  confidence?: number;
}
```

## `verify()` — PR Code Review (coming in `@concilium/sdk`)

```typescript
import { verify } from '@concilium/sdk';

const report = await verify({
  pr: 'https://github.com/org/repo/pull/42',
  githubToken: process.env.GITHUB_TOKEN,
  apiKey: process.env.OPENROUTER_API_KEY,
  threshold: 70,
  tier: 'pro',
});

console.log(report.verdict);       // 'PASS' or 'FAIL'
console.log(report.confidence);    // 0-100
console.log(report.disagreements); // Where jurors disagreed
console.log(report.synthesis);     // Full review text
```

### VerifyReport Type

```typescript
interface VerifyReport {
  runId: string;
  prNumber: number;
  repo: string;                    // "owner/repo"
  verdict: 'PASS' | 'FAIL';
  confidence: number;              // 0-100
  threshold: number;
  disagreements: Disagreement[];
  consensusRanking: string[];
  synthesis: string;
  stage2Summary: Stage2Summary[];
  totalCostUsd: number;
  durationMs: number;
  createdAt: string;
}
```

## Progress Events

```typescript
const result = await deliberate({
  prompt: '...',
  onProgress: {
    onStageChange: (stage, summary) => {
      console.log(`[Stage ${stage}] ${summary}`);
    },
    onAgentStatus: (key, status, name) => {
      console.log(`Agent ${name}: ${status}`);
    },
    onComplete: (record) => {
      console.log('Done:', record.id);
    },
    onError: (error) => {
      console.error('Failed:', error);
    },
  },
});
```

## Types

All domain types are exported from `@concilium/core`:

```typescript
import type {
  RunRecord,
  AgentResult,
  Stage1Result,
  Stage2Result,
  Stage3Result,
  ConfidenceScore,
  Disagreement,
  VerifyReport,
  ModelTier,
  PrDiff,
  PrFile,
} from '@concilium/core';
```
