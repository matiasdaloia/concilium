/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { CouncilConfig } from '../domain/council/council-config.js';
import type { ConfigStore } from '../ports/config-store.js';
import type { DeliberationEvents } from '../ports/deliberation-events.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import type { RunRepository } from '../ports/run-repository.js';
import type { SecretStore } from '../ports/secret-store.js';
import { createHeadlessCliDrivers } from '../adapters/cli/cli-drivers.js';
import { OpenRouterGateway } from '../adapters/openrouter-gateway.js';
import { ConfigService } from './config-service.js';
import { DeliberationService } from './deliberation-service.js';
import { ModelDiscoveryService } from './model-discovery-service.js';

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
  const drivers = createDrivers();
  const configService = new ConfigService(adapters.configStore, adapters.secretStore);

  return {
    ...adapters,
    drivers,
    configService,
    modelDiscovery: new ModelDiscoveryService(drivers),
    async createDeliberationService(events, overrides = {}) {
      const config = await configService.resolve(overrides);
      const llmGateway = new OpenRouterGateway(config.openRouterApiKey, config.openRouterApiUrl);
      return new DeliberationService({ runRepository: adapters.runRepository, drivers, llmGateway, config, events });
    },
  };
}
