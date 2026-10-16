import {
  createConciliumRuntime,
  JsonRunRepository,
  JsonConfigStore,
  PlaintextSecretStore,
  type AgentInstance,
  type AgentProviderType,
  type CouncilConfig,
  type RunRecord,
  type DeliberationEvents,
} from '@concilium/core';
import { createCallbackEventBridge, type EventHandler } from './adapters/callback-event-bridge.js';
import { getConfigDir, getDataDir } from './adapters/xdg-paths.js';

export interface ConciliumOptions {
  prompt: string;
  cwd?: string;
  agents?: Array<{ provider: string; model?: string }>;
  councilModels?: string[];
  chairmanModel?: string;
  apiKey?: string;
  onProgress?: EventHandler;
  save?: boolean;
}

/**
 * High-level convenience function for running a deliberation.
 * Suitable for use as a programmatic API or agent skill.
 */
export async function deliberate(options: ConciliumOptions): Promise<RunRecord> {
  const cwd = options.cwd ?? process.cwd();

  // Override with provided options
  const overrides: Partial<CouncilConfig> = {};
  if (options.apiKey) {
    overrides.openRouterApiKey = options.apiKey;
  }
  if (options.councilModels) {
    overrides.councilModels = options.councilModels;
  }
  if (options.chairmanModel) {
    overrides.chairmanModel = options.chairmanModel;
  }

  const runtime = createConciliumRuntime({
    secretStore: new PlaintextSecretStore(),
    configStore: new JsonConfigStore(getConfigDir()),
    runRepository: options.save !== false
      ? new JsonRunRepository(getDataDir())
      : { save: async () => '', load: async () => ({} as RunRecord), list: async () => [], loadAll: async () => [] },
  });

  // Build agent instances from options, else one per installed, signed-in agent CLI
  const agentInstances: AgentInstance[] = options.agents
    ? options.agents.map((a) => ({
        instanceId: crypto.randomUUID(),
        provider: a.provider as AgentProviderType,
        model: a.model ?? '',
        enabled: true,
      }))
    : await runtime.defaultAgentInstances();

  // Event bridge
  const noopEvents: DeliberationEvents = {
    onStageChange: () => {},
    onAgentStatus: () => {},
    onAgentEvent: () => {},
    onJurorStatus: () => {},
    onJurorChunk: () => {},
    onJurorComplete: () => {},
    onSynthesisStart: () => {},
    onComplete: () => {},
    onError: () => {},
  };
  const events = options.onProgress
    ? createCallbackEventBridge(options.onProgress)
    : noopEvents;

  const service = await runtime.createDeliberationService(events, overrides);

  return service.run({ prompt: options.prompt, images: [], agentInstances, cwd });
}

// Re-export everything from core for advanced usage
export * from '@concilium/core';
