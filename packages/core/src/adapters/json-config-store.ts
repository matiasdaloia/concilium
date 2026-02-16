import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentInstance } from '../domain/agent/agent-config.js';
import type { ConfigStore, CouncilConfigPrefs } from '../ports/config-store.js';

interface Preferences {
  lastOpencodeModel?: string;
  agentInstances?: AgentInstance[];
  councilConfig?: CouncilConfigPrefs;
  [key: string]: unknown;
}

function isValidAgentInstance(obj: unknown): obj is AgentInstance {
  if (typeof obj !== 'object' || obj === null) return false;
  const instance = obj as Record<string, unknown>;
  return (
    typeof instance.instanceId === 'string' &&
    typeof instance.provider === 'string' &&
    ['opencode', 'codex', 'claude'].includes(instance.provider) &&
    typeof instance.model === 'string' &&
    typeof instance.enabled === 'boolean'
  );
}

function createDefaultAgentInstances(): AgentInstance[] {
  return [
    { instanceId: randomUUID(), provider: 'opencode', model: '', enabled: true },
    { instanceId: randomUUID(), provider: 'opencode', model: '', enabled: true },
  ];
}

export class JsonConfigStore implements ConfigStore {
  constructor(private readonly configDir: string) {}

  private get prefsPath(): string {
    return join(this.configDir, 'preferences.json');
  }

  private async readPrefs(): Promise<Preferences> {
    try {
      const data = await readFile(this.prefsPath, 'utf-8');
      const parsed = JSON.parse(data);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  private async writePrefs(prefs: Preferences): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    await writeFile(this.prefsPath, JSON.stringify(prefs, null, 2), 'utf-8');
  }

  async getCouncilConfigPrefs(): Promise<CouncilConfigPrefs> {
    const prefs = await this.readPrefs();
    return prefs.councilConfig ?? {};
  }

  async saveCouncilConfigPrefs(config: CouncilConfigPrefs): Promise<void> {
    const prefs = await this.readPrefs();
    prefs.councilConfig = config;
    await this.writePrefs(prefs);
  }

  async getAgentInstances(): Promise<AgentInstance[]> {
    const prefs = await this.readPrefs();
    if (Array.isArray(prefs.agentInstances) && prefs.agentInstances.length > 0) {
      const validInstances = prefs.agentInstances.filter(isValidAgentInstance);
      if (validInstances.length >= 2) return validInstances;
    }
    return createDefaultAgentInstances();
  }

  async saveAgentInstances(instances: AgentInstance[]): Promise<void> {
    const prefs = await this.readPrefs();
    prefs.agentInstances = instances;
    await this.writePrefs(prefs);
  }

  async getLastOpencodeModel(): Promise<string | undefined> {
    const prefs = await this.readPrefs();
    return prefs.lastOpencodeModel;
  }

  async saveLastOpencodeModel(model: string): Promise<void> {
    const prefs = await this.readPrefs();
    prefs.lastOpencodeModel = model;
    await this.writePrefs(prefs);
  }
}
