/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import type { ModelPerformanceSnapshot, RunRecord } from '../types';
import { formatCost, formatCostPer1k, formatDuration, formatTokenCount, processCostEvaluations } from './analytics';

function snapshot(modelId: string, costPer1kTokens: number | null): ModelPerformanceSnapshot {
  return { modelId, provider: modelId, costPer1kTokens, latencyMs: 1000, speedTier: 'fast' };
}

function runWithFeedback(snapshots: ModelPerformanceSnapshot[]): RunRecord {
  return {
    id: 'run-1',
    createdAt: '2025-01-01T00:00:00.000Z',
    prompt: 'p',
    cwd: '/tmp',
    selectedAgents: [],
    agents: [],
    stage1: [],
    stage2: [],
    metadata: {
      labelToModel: {},
      aggregateRankings: [{ model: snapshots[0].modelId, averageRank: 1, rankingsCount: 1 }],
      userFeedback: { rankedModelIds: [snapshots[1].modelId], timestamp: '2025-01-01T00:00:00.000Z' },
      modelSnapshots: Object.fromEntries(snapshots.map((s) => [s.modelId, s])),
    },
  };
}

describe('analytics formatters', () => {
  it('should format costs, token counts and durations for display', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(12_340)).toBe('12.3k');
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(42.25)).toBe('42.3s');
    expect(formatDuration(125)).toBe('2m 5s');
  });
});

describe('subscription agent costs', () => {
  it('should show subscription agents as subscription instead of a price', () => {
    expect(formatCostPer1k(null)).toBe('subscription');
    expect(formatCostPer1k(0.005)).toBe('$0.0050/1k tokens');
  });

  it('should not compare costs when an agent runs on a subscription', () => {
    const result = processCostEvaluations([runWithFeedback([snapshot('claude', 0.002), snapshot('codex', null)])]);
    expect(result.insights).toEqual([]);
    expect(result.potentialSavings).toBe(0);
  });
});
