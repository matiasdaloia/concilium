import type {
  DeliberationEvents,
  AgentStatus,
  ParsedEvent,
  CouncilTokenUsage,
  RunRecord,
} from '@concilium/core';

export type EventHandler = {
  onStageChange?: (stage: number, summary: string) => void;
  onAgentStatus?: (agentKey: string, status: AgentStatus, name?: string) => void;
  onAgentEvent?: (agentKey: string, event: ParsedEvent) => void;
  onJurorStatus?: (model: string, status: string) => void;
  onJurorChunk?: (model: string, chunk: string) => void;
  onJurorComplete?: (model: string, success: boolean, usage?: CouncilTokenUsage) => void;
  onSynthesisStart?: () => void;
  onComplete?: (record: RunRecord) => void;
  onError?: (error: string) => void;
};

export function createCallbackEventBridge(handlers: EventHandler): DeliberationEvents {
  return {
    onStageChange: (stage, summary) => handlers.onStageChange?.(stage, summary),
    onAgentStatus: (agentKey, status, name) => handlers.onAgentStatus?.(agentKey, status, name),
    onAgentEvent: (agentKey, event) => handlers.onAgentEvent?.(agentKey, event),
    onJurorStatus: (model, status) => handlers.onJurorStatus?.(model, status),
    onJurorChunk: (model, chunk) => handlers.onJurorChunk?.(model, chunk),
    onJurorComplete: (model, success, usage) => handlers.onJurorComplete?.(model, success, usage),
    onSynthesisStart: () => handlers.onSynthesisStart?.(),
    onComplete: (record) => handlers.onComplete?.(record),
    onError: (error) => handlers.onError?.(error),
  };
}
