/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { CouncilConfig } from '../domain/council/council-config.js';
import { PROVIDER_IDS, type AgentProviderType } from '../domain/agent/providers.js';
import type { AgentProvider } from '../ports/agent-provider.js';
import type { ConfigStore } from '../ports/config-store.js';
import type { DeliberationEvents } from '../ports/deliberation-events.js';
import type { RunRepository } from '../ports/run-repository.js';
import type { SecretStore } from '../ports/secret-store.js';
import { ClaudeProvider } from '../adapters/claude-provider.js';
import { CodexProvider } from '../adapters/codex-provider.js';
import { OpenCodeProvider } from '../adapters/opencode-provider.js';
import { OpenRouterGateway } from '../adapters/openrouter-gateway.js';
import { ConfigService } from './config-service.js';
import { DeliberationService } from './deliberation-service.js';
import { ModelDiscoveryService } from './model-discovery-service.js';

/** One factory per registry id. Adding a provider to `PROVIDERS` without a factory fails to compile. */
const PROVIDER_FACTORIES: Record<AgentProviderType, () => AgentProvider> = {
  claude: () => new ClaudeProvider(),
  codex: () => new CodexProvider(),
  opencode: () => new OpenCodeProvider(),
};

/** Build providers for the given ids (all registered providers by default), in registry order. */
export function createProviders(ids: readonly string[] = PROVIDER_IDS): Map<string, AgentProvider> {
  const providers = new Map<string, AgentProvider>();
  for (const id of PROVIDER_IDS) {
    if (ids.includes(id)) providers.set(id, PROVIDER_FACTORIES[id]());
  }
  return providers;
}

/** The shell-specific adapters each entry point supplies. */
export interface ConciliumAdapters {
  configStore: ConfigStore;
  secretStore: SecretStore;
  runRepository: RunRepository;
}

export interface ConciliumRuntime extends ConciliumAdapters {
  providers: Map<string, AgentProvider>;
  configService: ConfigService;
  modelDiscovery: ModelDiscoveryService;
  /**
   * Resolve config once with `overrides` on top (see `ConfigService.resolve`),
   * build the OpenRouter gateway from it, and return a service that runs with
   * that config and reports progress to `events`.
   */
  createDeliberationService(
    events: DeliberationEvents,
    overrides?: Partial<CouncilConfig>,
  ): Promise<DeliberationService>;
}

/** The composition root shared by the CLI command, the CLI library entry point and the desktop app. */
export function createConciliumRuntime(adapters: ConciliumAdapters): ConciliumRuntime {
  const providers = createProviders();
  const configService = new ConfigService(adapters.configStore, adapters.secretStore);

  return {
    ...adapters,
    providers,
    configService,
    modelDiscovery: new ModelDiscoveryService(providers),
    async createDeliberationService(events, overrides = {}) {
      const config = await configService.resolve(overrides);
      const llmGateway = new OpenRouterGateway(config.openRouterApiKey, config.openRouterApiUrl);
      return new DeliberationService({ runRepository: adapters.runRepository, providers, llmGateway, config, events });
    },
  };
}
