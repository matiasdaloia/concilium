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
  costPer1kTokens: number;
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
