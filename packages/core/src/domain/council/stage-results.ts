export interface Stage1Result {
  model: string;
  response: string;
}

export interface CouncilTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface Stage2Result {
  model: string;
  ranking: string;
  parsedRanking: string[];
  usage?: CouncilTokenUsage | null;
  startedAt?: string | null;
  endedAt?: string | null;
  estimatedCost?: number | null;
}

export interface Stage3Result {
  model: string;
  response: string;
  usage?: CouncilTokenUsage | null;
  startedAt?: string | null;
  endedAt?: string | null;
  estimatedCost?: number | null;
}
