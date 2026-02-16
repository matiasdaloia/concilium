import type { AgentId, AgentStatus } from './agent-config.js';
import type { ParsedEvent } from './parsed-event.js';

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
