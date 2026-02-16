import {
  DeliberationService,
  OpenRouterGateway,
  ClaudeProvider,
  CodexProvider,
  OpenCodeProvider,
  JsonRunRepository,
  JsonConfigStore,
  PlaintextSecretStore,
  ConfigService,
  type AgentInstance,
  type AgentProvider,
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

  // Build agent instances from options
  const agentInstances: AgentInstance[] = options.agents
    ? options.agents.map((a) => ({
        instanceId: crypto.randomUUID(),
        provider: a.provider as 'claude' | 'codex' | 'opencode',
        model: a.model ?? '',
        enabled: true,
      }))
    : [
        { instanceId: crypto.randomUUID(), provider: 'opencode' as const, model: '', enabled: true },
        { instanceId: crypto.randomUUID(), provider: 'opencode' as const, model: '', enabled: true },
      ];

  // Build providers
  const providers = new Map<string, AgentProvider>();
  providers.set('claude', new ClaudeProvider());
  providers.set('codex', new CodexProvider());
  providers.set('opencode', new OpenCodeProvider());

  // Build config
  const secretStore = new PlaintextSecretStore();
  const configStore = new JsonConfigStore(getConfigDir());
  const configService = new ConfigService(configStore, secretStore);
  const config = await configService.resolve();

  // Override with provided options
  if (options.apiKey) {
    config.openRouterApiKey = options.apiKey;
  }
  if (options.councilModels) {
    config.councilModels = options.councilModels;
  }
  if (options.chairmanModel) {
    config.chairmanModel = options.chairmanModel;
  }

  const llmGateway = new OpenRouterGateway(config.openRouterApiKey, config.openRouterApiUrl);
  const runRepository = options.save !== false
    ? new JsonRunRepository(getDataDir())
    : { save: async () => '', load: async () => ({} as RunRecord), list: async () => [], loadAll: async () => [] };

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

  const service = new DeliberationService({
    providers,
    llmGateway,
    configStore,
    secretStore,
    runRepository,
    events,
  });

  return service.run({ prompt: options.prompt, images: [], agentInstances, cwd });
}

// Re-export everything from core for advanced usage
export * from '@concilium/core';
