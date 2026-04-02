import type { RunRecord } from '../run/run-record.js';
import type { ConfidenceScore, Disagreement } from './confidence.js';

export interface Stage2Summary {
  jurorModel: string;
  topRankedAgent: string;
  estimatedCost: number | null;
}

export interface VerifyReport {
  runId: string;
  prNumber: number;
  repo: string;
  verdict: 'PASS' | 'FAIL';
  confidence: number;
  threshold: number;
  disagreements: Disagreement[];
  consensusRanking: string[];
  synthesis: string;
  stage2Summary: Stage2Summary[];
  totalCostUsd: number;
  durationMs: number;
  createdAt: string;
}

export function buildVerifyReport(
  record: RunRecord,
  confidence: ConfidenceScore,
  prNumber: number,
  repo: string,
  threshold: number,
  durationMs: number,
): VerifyReport {
  const stage2Summary: Stage2Summary[] = record.stage2.map((s2) => ({
    jurorModel: s2.model,
    topRankedAgent: s2.parsedRanking?.[0] ?? 'unknown',
    estimatedCost: s2.estimatedCost ?? null,
  }));

  const stage2Cost = record.stage2.reduce(
    (sum, r) => sum + (r.estimatedCost ?? 0),
    0,
  );
  const stage3Cost = record.stage3?.estimatedCost ?? 0;
  const totalCostUsd = stage2Cost + stage3Cost;

  return {
    runId: record.id,
    prNumber,
    repo,
    verdict: confidence.verdict,
    confidence: confidence.score,
    threshold,
    disagreements: confidence.disagreements,
    consensusRanking: confidence.consensusRanking,
    synthesis: record.stage3?.response ?? '',
    stage2Summary,
    totalCostUsd,
    durationMs,
    createdAt: record.createdAt,
  };
}
