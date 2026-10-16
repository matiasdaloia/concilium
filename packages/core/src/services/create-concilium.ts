/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { PROVIDER_IDS, type AgentProviderType } from '../domain/agent/providers.js';
import type { CouncilConfig } from '../domain/council/council-config.js';
import { parseCouncilMember, resolveCouncil } from '../domain/council/council-members.js';
import type { ConfigStore } from '../ports/config-store.js';
import type { DeliberationEvents } from '../ports/deliberation-events.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import type { RunRepository } from '../ports/run-repository.js';
import type { SecretStore } from '../ports/secret-store.js';
import { createLogger } from '../shared/logger.js';
import { CliCouncilGateway } from '../adapters/cli/cli-council-gateway.js';
import { createHeadlessCliDrivers } from '../adapters/cli/cli-drivers.js';
import { OpenRouterGateway } from '../adapters/openrouter-gateway.js';
import { ConfigService } from './config-service.js';
import { DeliberationService } from './deliberation-service.js';
import { ModelDiscoveryService } from './model-discovery-service.js';

const log = createLogger('runtime');

/** One driver per registered provider, keyed by provider id, in registry order. */
export function createDrivers(env: NodeJS.ProcessEnv = process.env): Map<string, HeadlessCliDriver> {
  return new Map(createHeadlessCliDrivers(env).map((driver) => [driver.id, driver]));
}

/** The shell-specific adapters each entry point supplies. */
export interface ConciliumAdapters {
  configStore: ConfigStore;
  secretStore: SecretStore;
  runRepository: RunRepository;
}

export interface ConciliumRuntime extends ConciliumAdapters {
  /** The agent CLI drivers, keyed by provider id. Tests replace entries with `FakeCliDriver`s. */
  drivers: Map<string, HeadlessCliDriver>;
  configService: ConfigService;
  modelDiscovery: ModelDiscoveryService;
  /**
   * Resolve config with `overrides` on top (see `ConfigService.resolve`), then fill in missing jurors and
   * chairman from the installed, signed-in agent CLIs (see `resolveCouncil`).
   */
  resolveCouncilConfig(overrides?: Partial<CouncilConfig>): Promise<{ config: CouncilConfig; notes: string[] }>;
  /**
   * Resolve the council config once, build the council gateway from it (agent CLIs, plus OpenRouter when an API
   * key is configured), and return a service that runs with that config and reports progress to `events`.
   */
  createDeliberationService(
    events: DeliberationEvents,
    overrides?: Partial<CouncilConfig>,
  ): Promise<DeliberationService>;
}

/** The registered CLIs that are installed and not signed out. A CLI whose detection fails counts as unusable. */
async function usableClis(drivers: ReadonlyMap<string, HeadlessCliDriver>): Promise<AgentProviderType[]> {
  const usable = await Promise.all(
    PROVIDER_IDS.map(async (id) => {
      const detection = await drivers.get(id)?.detect().catch(() => undefined);
      return detection?.installed && detection.auth !== 'none' ? id : null;
    }),
  );
  return usable.filter((id): id is AgentProviderType => id !== null);
}

/** The composition root shared by the CLI command, the CLI library entry point and the desktop app. */
export function createConciliumRuntime(adapters: ConciliumAdapters): ConciliumRuntime {
  const drivers = createDrivers();
  const configService = new ConfigService(adapters.configStore, adapters.secretStore);

  const runtime: ConciliumRuntime = {
    ...adapters,
    drivers,
    configService,
    modelDiscovery: new ModelDiscoveryService(drivers),
    async resolveCouncilConfig(overrides = {}) {
      const config = await configService.resolve(overrides);
      // Detecting CLIs spawns them, so only detect when a juror list or chairman is left to fill in.
      const usable = (spec: string) => !!config.openRouterApiKey || parseCouncilMember(spec).kind === 'cli';
      const needsDefaults = !config.councilModels.some(usable) || !(config.chairmanModel && usable(config.chairmanModel));
      const council = resolveCouncil({
        councilModels: config.councilModels,
        chairmanModel: config.chairmanModel,
        usableClis: needsDefaults ? await usableClis(drivers) : [],
        hasOpenRouterKey: !!config.openRouterApiKey,
      });
      log.info(`council: jurors ${council.councilModels.join(', ') || '(none)'}; chairman ${council.chairmanModel || '(none)'}`);
      return { config: { ...config, councilModels: council.councilModels, chairmanModel: council.chairmanModel }, notes: council.notes };
    },
    async createDeliberationService(events, overrides = {}) {
      const { config, notes } = await runtime.resolveCouncilConfig(overrides);
      const openRouter = config.openRouterApiKey ? new OpenRouterGateway(config.openRouterApiKey, config.openRouterApiUrl) : null;
      const llmGateway = new CliCouncilGateway({ drivers, openRouter });
      return new DeliberationService({ runRepository: adapters.runRepository, drivers, llmGateway, config, events, councilNotes: notes });
    },
  };
  return runtime;
}
