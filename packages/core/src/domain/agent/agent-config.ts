export type BuiltinAgentId = 'codex' | 'claude' | 'opencode';
export type McpAgentId = `mcp-${string}`;
export type AgentId = BuiltinAgentId | McpAgentId;
export type BuiltinProviderType = 'opencode' | 'codex' | 'claude';
export type AgentProviderType = BuiltinProviderType | 'mcp';

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
