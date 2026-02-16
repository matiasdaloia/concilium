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
