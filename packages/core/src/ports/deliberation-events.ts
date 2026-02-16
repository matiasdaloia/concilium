import type { AgentStatus } from '../domain/agent/agent-config.js';
import type { ParsedEvent } from '../domain/agent/parsed-event.js';
import type { CouncilTokenUsage } from '../domain/council/stage-results.js';
import type { RunRecord } from '../domain/run/run-record.js';

export interface DeliberationEvents {
  onStageChange(stage: number, summary: string): void;
  onAgentStatus(agentKey: string, status: AgentStatus, name?: string): void;
  onAgentEvent(agentKey: string, event: ParsedEvent): void;
  onJurorStatus(model: string, status: string): void;
  onJurorChunk(model: string, chunk: string): void;
  onJurorComplete(model: string, success: boolean, usage?: CouncilTokenUsage): void;
  onSynthesisStart(): void;
  onComplete(record: RunRecord): void;
  onError(error: string): void;
}
