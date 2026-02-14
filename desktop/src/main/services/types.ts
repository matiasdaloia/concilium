export type AgentId = 'codex' | 'claude' | 'opencode';
export type AgentProvider = 'opencode' | 'codex' | 'claude';

export interface AgentInstance {
  instanceId: string;           // UUID for this card
  provider: AgentProvider;      // Which CLI agent
  model: string;                // Selected model (e.g., "anthropic/claude-sonnet-4")
  enabled: boolean;             // Toggle state
}
export type AgentStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled' | 'aborted';
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

export interface AgentConfig {
  id: AgentId;
  /** Unique instance identifier for multi-instance support */
  instanceId?: string;
  name: string;
  enabled: boolean;
  model?: string | null;
  cwd: string;
  env?: Record<string, string> | null;
}

export interface AgentResult {
  id: AgentId;
  /** Unique key (instanceId or id for legacy) */
  agentKey?: string;
  name: string;
  status: AgentStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  /** Raw output lines - no longer stored for new runs (kept for backward compatibility) */
  rawOutput?: string[];
  normalizedPlan: string;
  errors: string[];
  command: string[];
  events: ParsedEvent[];
}

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

export interface RunRecord {
  id: string;
  createdAt: string;
  prompt: string;
  cwd: string;
  selectedAgents: AgentId[];
  agents: AgentResult[];
  stage1: Stage1Result[];
  stage2: Stage2Result[];
  stage3?: Stage3Result | null;
  metadata: RunMetadata;
}

export interface CouncilConfig {
  openRouterApiKey: string;
  openRouterApiUrl: string;
  councilModels: string[];
  chairmanModel: string;
}

export interface CommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ImageAttachment {
  path?: string;
  base64?: string;
  mimeType: string;
}

export interface StartRunConfig {
  prompt: string;
  images?: ImageAttachment[];
  agents: AgentId[];
  agentModels?: Partial<Record<AgentId, string>>;
  /** Full instance data for multi-instance support */
  agentInstances?: AgentInstance[];
}
