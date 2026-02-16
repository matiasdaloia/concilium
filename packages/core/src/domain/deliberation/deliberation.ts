import type { AgentId, AgentInstance } from '../agent/agent-config.js';

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
