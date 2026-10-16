import type { AgentInstance } from '../domain/agent/agent-config.js';

export interface CouncilConfigPrefs {
  chairmanModel?: string;
  councilModels?: string[];
  apiKeyEncrypted?: string;
}

export interface ConfigStore {
  getCouncilConfigPrefs(): Promise<CouncilConfigPrefs>;
  saveCouncilConfigPrefs(config: CouncilConfigPrefs): Promise<void>;
  /** The saved Stage 1 agents, or none when fewer than two valid ones are saved (the caller picks the defaults). */
  getAgentInstances(): Promise<AgentInstance[]>;
  saveAgentInstances(instances: AgentInstance[]): Promise<void>;
  getLastOpencodeModel(): Promise<string | undefined>;
  saveLastOpencodeModel(model: string): Promise<void>;
}
