import type { Stage1Result, Stage2Result } from '../council/stage-results.js';
import type { AggregateRanking } from '../run/run-metadata.js';

export interface Disagreement {
  agentName: string;
  jurorModel: string;
  rank: number;
  medianRank: number;
  delta: number;
}

export interface ConfidenceScore {
  score: number;
  verdict: 'PASS' | 'FAIL';
  disagreements: Disagreement[];
  consensusRanking: string[];
}

/**
 * Kendall tau distance between two rankings.
 * Returns a value between 0 (identical) and 1 (completely reversed).
 */
function kendallTauDistance(a: string[], b: string[]): number {
  const n = a.length;
  if (n <= 1) return 0;

  const indexInB = new Map<string, number>();
  for (let i = 0; i < b.length; i++) {
    indexInB.set(b[i], i);
  }

  let discordant = 0;
  const maxPairs = (n * (n - 1)) / 2;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const biPos = indexInB.get(a[i]);
      const bjPos = indexInB.get(a[j]);
      if (biPos === undefined || bjPos === undefined) continue;
      if (biPos > bjPos) discordant++;
    }
  }

  return discordant / maxPairs;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function detectDisagreements(
  stage2Results: Stage2Result[],
  labelToAgent: Map<string, string>,
): Disagreement[] {
  const agentRanks = new Map<string, Map<string, number>>();

  for (const juror of stage2Results) {
    if (!juror.parsedRanking || juror.parsedRanking.length === 0) continue;

    for (let i = 0; i < juror.parsedRanking.length; i++) {
      const label = juror.parsedRanking[i];
      const agentName = labelToAgent.get(label) ?? label;

      if (!agentRanks.has(agentName)) {
        agentRanks.set(agentName, new Map());
      }
      agentRanks.get(agentName)!.set(juror.model, i + 1);
    }
  }

  const disagreements: Disagreement[] = [];

  for (const [agentName, jurorRanks] of agentRanks) {
    const allRanks = [...jurorRanks.values()];
    const medianRank = median(allRanks);

    for (const [jurorModel, rank] of jurorRanks) {
      const delta = Math.abs(rank - medianRank);
      if (delta > 1) {
        disagreements.push({ agentName, jurorModel, rank, medianRank, delta });
      }
    }
  }

  return disagreements.sort((a, b) => b.delta - a.delta);
}

export function calculateConfidence(
  stage2Results: Stage2Result[],
  stage1Results: Stage1Result[],
  aggregateRankings: AggregateRanking[],
  labelToModel: Record<string, string>,
  threshold: number = 70,
): ConfidenceScore {
  const consensusRanking = aggregateRankings
    .sort((a, b) => a.averageRank - b.averageRank)
    .map((r) => r.model);

  if (stage2Results.length === 0) {
    return { score: 0, verdict: 'FAIL', disagreements: [], consensusRanking };
  }

  if (stage2Results.length === 1) {
    return { score: 100, verdict: 100 >= threshold ? 'PASS' : 'FAIL', disagreements: [], consensusRanking };
  }

  const validRankings = stage2Results
    .filter((r) => r.parsedRanking && r.parsedRanking.length > 0)
    .map((r) => r.parsedRanking);

  if (validRankings.length <= 1) {
    const score = validRankings.length === 1 ? 100 : 0;
    return { score, verdict: score >= threshold ? 'PASS' : 'FAIL', disagreements: [], consensusRanking };
  }

  let totalDistance = 0;
  let pairCount = 0;

  for (let i = 0; i < validRankings.length; i++) {
    for (let j = i + 1; j < validRankings.length; j++) {
      totalDistance += kendallTauDistance(validRankings[i], validRankings[j]);
      pairCount++;
    }
  }

  const meanDistance = pairCount > 0 ? totalDistance / pairCount : 0;
  const score = Math.round(100 * (1 - meanDistance));

  const labelToAgent = new Map<string, string>();
  for (const [label, model] of Object.entries(labelToModel)) {
    labelToAgent.set(label, model);
  }

  const disagreements = detectDisagreements(stage2Results, labelToAgent);

  return {
    score,
    verdict: score >= threshold ? 'PASS' : 'FAIL',
    disagreements,
    consensusRanking,
  };
}
