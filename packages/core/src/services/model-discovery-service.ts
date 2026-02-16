import type { AgentProvider } from '../ports/agent-provider.js';
import type { AgentModelInfo } from '../domain/agent/agent-executor.js';
import { DEFAULT_AGENT_MODELS } from '../domain/agent/agent-executor.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('model-discovery');

export class ModelDiscoveryService {
  constructor(private providers: Map<string, AgentProvider>) {}

  async discoverAll(): Promise<AgentModelInfo[]> {
    const results: AgentModelInfo[] = [];

    for (const [id, provider] of this.providers) {
      try {
        const models = await provider.discoverModels();
        results.push({
          id,
          models,
          defaultModel: DEFAULT_AGENT_MODELS[id] ?? models[0] ?? '',
          supportsDiscovery: id === 'opencode',
        });
      } catch (err) {
        log.warn(`discoverAll: failed for ${id}:`, err instanceof Error ? err.message : String(err));
        results.push({
          id,
          models: [],
          defaultModel: DEFAULT_AGENT_MODELS[id] ?? '',
          supportsDiscovery: id === 'opencode',
        });
      }
    }

    return results;
  }
}
