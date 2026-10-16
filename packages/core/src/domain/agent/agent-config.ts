import type { AgentProviderType } from './providers.js';

export type { AgentProviderType };
export type AgentId = AgentProviderType;

export interface AgentInstance {
  instanceId: string;
  provider: AgentProviderType;
  model: string;
  enabled: boolean;
}

export type AgentStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled' | 'aborted';

export interface AgentConfig {
  id: AgentId;
  instanceId?: string;
  name: string;
  enabled: boolean;
  model?: string | null;
  cwd: string;
  env?: Record<string, string> | null;
}
