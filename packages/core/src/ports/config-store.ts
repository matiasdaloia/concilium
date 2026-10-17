import type { AgentInstance } from '../domain/agent/agent-config.js';
import type { RoleSettings } from '../domain/roles/roles.js';

export interface CouncilConfigPrefs {
  chairmanModel?: string;
  councilModels?: string[];
  apiKeyEncrypted?: string;
  /** Saved code-council roles (`concilium config set <role> ...`). Jurors and the chairman stay in the fields above. */
  roles?: RoleSettings;
  /** `concilium config set allow-same-family-verifier true|false`: a configured author-family verifier may verify. */
  allowSameFamilyVerifier?: boolean;
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
