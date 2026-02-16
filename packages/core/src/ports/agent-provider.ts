import type { AgentConfig, AgentStatus } from '../domain/agent/agent-config.js';
import type { AgentResult } from '../domain/agent/agent-result.js';
import type { ImageAttachment } from '../domain/deliberation/deliberation.js';
import type { ParsedEvent } from '../domain/agent/parsed-event.js';

export type StatusCallback = (agentKey: string, status: AgentStatus) => void;
export type EventCallback = (agentKey: string, event: ParsedEvent) => void;

export interface RunnerCallbacks {
  onStatus?: StatusCallback;
  onEvent?: EventCallback;
}

export interface AgentProvider {
  readonly id: string;
  readonly name: string;
  discoverModels(): Promise<string[]>;
  execute(config: AgentExecutionConfig): Promise<AgentResult>;
}

export interface AgentExecutionConfig {
  agent: AgentConfig;
  prompt: string;
  images?: ImageAttachment[];
  callbacks: RunnerCallbacks;
  abortSignal?: AbortSignal;
}
