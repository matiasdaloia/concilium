export type AgentId = 'codex' | 'claude' | 'opencode';
export type AgentProvider = 'opencode' | 'codex' | 'claude';

export interface AgentInstance {
  instanceId: string;           // UUID for this card
  provider: AgentProvider;      // Which CLI agent
  model: string;                // Selected model (e.g., "anthropic/claude-sonnet-4")
  enabled: boolean;             // Toggle state
}
export type RunMode = 'safe' | 'advanced';
export type AgentStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled';
export type EventType = 'text' | 'thinking' | 'tool_call' | 'status' | 'raw';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalCost?: number | null;
}

export interface ParsedEvent {
  eventType: EventType;
  text: string;
  metadata?: Record<string, unknown> | null;
  tokenUsage?: TokenUsage | null;
  /** If true, tokenUsage is a cumulative total — replace, don't sum */
  tokenUsageCumulative?: boolean;
  rawLine: string;
}

export interface AgentResult {
  id: AgentId;
  /** Unique key (instanceId or id for legacy) */
  agentKey?: string;
  name: string;
  status: AgentStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  rawOutput: string[];
  normalizedPlan: string;
  errors: string[];
  command: string[];
  events: ParsedEvent[];
}

export interface Stage1Result {
  model: string;
  response: string;
}

export interface Stage2Result {
  model: string;
  ranking: string;
  parsedRanking: string[];
}

export interface Stage3Result {
  model: string;
  response: string;
}

export interface AggregateRanking {
  model: string;
  averageRank: number;
  rankingsCount: number;
}

export interface RunMetadata {
  labelToModel: Record<string, string>;
  aggregateRankings: AggregateRanking[];
  notes?: string[] | null;
}

export interface RunRecord {
  id: string;
  createdAt: string;
  prompt: string;
  cwd: string;
  mode: RunMode;
  selectedAgents: AgentId[];
  agents: AgentResult[];
  stage1: Stage1Result[];
  stage2: Stage2Result[];
  stage3?: Stage3Result | null;
  metadata: RunMetadata;
}

export interface CouncilConfig {
  councilModels: string[];
  chairmanModel: string;
  hasApiKey: boolean;
  apiKeySetInEnv: boolean;
}

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: number;
    completion: number;
  };
}

export interface StartRunConfig {
  prompt: string;
  agents: AgentId[];
  mode: RunMode;
  agentModels?: Partial<Record<AgentId, string>>;
}

export interface AgentModelInfo {
  id: string;
  models: string[];
  defaultModel: string;
  supportsDiscovery: boolean;
}
