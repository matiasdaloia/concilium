/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { createElement } from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import type { AgentResult, RunRecord } from '@concilium/core';
import { AgentProgress } from './AgentProgress.js';
import { CostSummary } from './CostSummary.js';

function agent(name: string, totalCost: number | null): AgentResult {
  return {
    id: 'claude',
    name,
    status: 'success',
    normalizedPlan: 'plan',
    errors: [],
    command: [],
    events: [{
      eventType: 'text',
      text: 'plan',
      rawLine: '',
      tokenUsage: { inputTokens: 100, outputTokens: 20, totalCost },
      tokenUsageCumulative: true,
    }],
  };
}

function record(agents: AgentResult[]): RunRecord {
  return {
    id: 'run-1',
    createdAt: '2025-01-01T00:00:00.000Z',
    prompt: 'p',
    cwd: '/tmp',
    selectedAgents: [],
    agents,
    stage1: [],
    stage2: [],
    metadata: { labelToModel: {}, aggregateRankings: [] },
  };
}

describe('agent CLI cost label', () => {
  it('should label a CLI-reported agent cost as estimated API-equivalent in the cost summary', () => {
    const out = renderToString(createElement(CostSummary, { record: record([agent('claude · opus', 0.0123)]) }));

    expect(out).toContain('$0.012');
    expect(out).toContain('Agents (cost: est. API-equivalent)');
    expect(out).toContain('Total (incl. est. API-equivalent)');
  });

  it('should not add the label when no agent reported a cost', () => {
    const out = renderToString(createElement(CostSummary, { record: record([agent('codex · gpt-5', null)]) }));

    expect(out).not.toContain('API-equivalent');
  });

  it('should label the live agent cost as estimated API-equivalent', () => {
    const out = renderToString(createElement(AgentProgress, {
      name: 'claude · opus', status: 'success', inputTokens: 100, outputTokens: 20, totalCost: 0.0123,
    }));

    expect(out).toContain('$0.012 est. API-equivalent');
  });
});
