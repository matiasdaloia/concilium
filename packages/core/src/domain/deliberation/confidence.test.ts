import { describe, it, expect } from 'vitest';
import { calculateConfidence } from './confidence.js';
import type { Stage1Result, Stage2Result } from '../council/stage-results.js';
import type { AggregateRanking } from '../run/run-metadata.js';

function makeStage1(models: string[]): Stage1Result[] {
  return models.map((model) => ({ model, response: `Plan from ${model}` }));
}

function makeStage2(jurorRankings: Record<string, string[]>): Stage2Result[] {
  return Object.entries(jurorRankings).map(([model, parsedRanking]) => ({
    model,
    ranking: parsedRanking.join(', '),
    parsedRanking,
  }));
}

function makeAggregateRankings(models: string[], avgRanks: number[]): AggregateRanking[] {
  return models.map((model, i) => ({
    model,
    averageRank: avgRanks[i],
    rankingsCount: 3,
  }));
}

const labelToModel = {
  'Response A': 'agent-1',
  'Response B': 'agent-2',
  'Response C': 'agent-3',
};

describe('calculateConfidence', () => {
  it('returns score=100 when all jurors agree', () => {
    const stage1 = makeStage1(['agent-1', 'agent-2', 'agent-3']);
    const stage2 = makeStage2({
      'juror-1': ['Response A', 'Response B', 'Response C'],
      'juror-2': ['Response A', 'Response B', 'Response C'],
      'juror-3': ['Response A', 'Response B', 'Response C'],
    });
    const agg = makeAggregateRankings(['agent-1', 'agent-2', 'agent-3'], [1, 2, 3]);

    const result = calculateConfidence(stage2, stage1, agg, labelToModel);

    expect(result.score).toBe(100);
    expect(result.disagreements).toHaveLength(0);
    expect(result.consensusRanking).toEqual(['agent-1', 'agent-2', 'agent-3']);
  });

  it('returns score < 50 when jurors fully disagree', () => {
    const stage1 = makeStage1(['agent-1', 'agent-2', 'agent-3']);
    // Complete reversal across 3 jurors produces maximum Kendall tau distance
    const stage2 = makeStage2({
      'juror-1': ['Response A', 'Response B', 'Response C'],
      'juror-2': ['Response C', 'Response B', 'Response A'],
      'juror-3': ['Response B', 'Response C', 'Response A'],
    });
    const agg = makeAggregateRankings(['agent-1', 'agent-2', 'agent-3'], [2, 2, 2]);

    const result = calculateConfidence(stage2, stage1, agg, labelToModel);

    expect(result.score).toBeLessThan(50);
  });

  it('returns score=0 and FAIL when no jurors exist', () => {
    const stage1 = makeStage1(['agent-1']);
    const agg = makeAggregateRankings(['agent-1'], [1]);

    const result = calculateConfidence([], stage1, agg, labelToModel);

    expect(result.score).toBe(0);
    expect(result.verdict).toBe('FAIL');
  });

  it('returns score=100 when only one juror exists', () => {
    const stage1 = makeStage1(['agent-1', 'agent-2']);
    const stage2 = makeStage2({
      'juror-1': ['Response A', 'Response B'],
    });
    const agg = makeAggregateRankings(['agent-1', 'agent-2'], [1, 2]);

    const result = calculateConfidence(stage2, stage1, agg, labelToModel);

    expect(result.score).toBe(100);
  });

  it('respects threshold for verdict', () => {
    const stage1 = makeStage1(['agent-1', 'agent-2']);
    const stage2 = makeStage2({
      'juror-1': ['Response A', 'Response B'],
      'juror-2': ['Response A', 'Response B'],
    });
    const agg = makeAggregateRankings(['agent-1', 'agent-2'], [1, 2]);

    const passResult = calculateConfidence(stage2, stage1, agg, labelToModel, 70);
    expect(passResult.verdict).toBe('PASS');

    const failResult = calculateConfidence(stage2, stage1, agg, labelToModel, 101);
    expect(failResult.verdict).toBe('FAIL');
  });

  it('score is always between 0 and 100', () => {
    const stage1 = makeStage1(['agent-1', 'agent-2', 'agent-3']);
    const rankings = [
      ['Response A', 'Response B', 'Response C'],
      ['Response C', 'Response A', 'Response B'],
      ['Response B', 'Response C', 'Response A'],
    ];
    const stage2 = makeStage2({
      'juror-1': rankings[0],
      'juror-2': rankings[1],
      'juror-3': rankings[2],
    });
    const agg = makeAggregateRankings(['agent-1', 'agent-2', 'agent-3'], [2, 2, 2]);

    const result = calculateConfidence(stage2, stage1, agg, labelToModel);

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('detects disagreements where rank deviates > 1 from median', () => {
    const stage1 = makeStage1(['agent-1', 'agent-2', 'agent-3']);
    const stage2 = makeStage2({
      'juror-1': ['Response A', 'Response B', 'Response C'],
      'juror-2': ['Response A', 'Response B', 'Response C'],
      'juror-3': ['Response C', 'Response B', 'Response A'],
    });
    const agg = makeAggregateRankings(['agent-1', 'agent-2', 'agent-3'], [1.33, 2, 2.67]);

    const result = calculateConfidence(stage2, stage1, agg, labelToModel);

    expect(result.disagreements.length).toBeGreaterThan(0);
    const agentNames = result.disagreements.map((d) => d.agentName);
    expect(agentNames).toContain('agent-1');
    expect(agentNames).toContain('agent-3');
  });

  it('consensusRanking matches aggregateRankings sorted by averageRank', () => {
    const stage1 = makeStage1(['agent-1', 'agent-2', 'agent-3']);
    const stage2 = makeStage2({
      'juror-1': ['Response B', 'Response A', 'Response C'],
    });
    const agg = makeAggregateRankings(['agent-2', 'agent-1', 'agent-3'], [1, 2, 3]);

    const result = calculateConfidence(stage2, stage1, agg, labelToModel);

    expect(result.consensusRanking).toEqual(['agent-2', 'agent-1', 'agent-3']);
  });
});
