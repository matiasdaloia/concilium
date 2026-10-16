export interface AggregateRanking {
  model: string;
  averageRank: number;
  rankingsCount: number;
}

export interface UserRanking {
  rankedModelIds: string[];
  timestamp: string;
}

export interface ModelPerformanceSnapshot {
  modelId: string;
  provider: string;
  /** null when the agent runs on a subscription CLI and has no per-token price. */
  costPer1kTokens: number | null;
  latencyMs: number;
  speedTier: 'fast' | 'balanced' | 'slow';
}

export interface RunMetadata {
  labelToModel: Record<string, string>;
  aggregateRankings: AggregateRanking[];
  notes?: string[] | null;
  userFeedback?: UserRanking;
  modelSnapshots?: Record<string, ModelPerformanceSnapshot>;
}
