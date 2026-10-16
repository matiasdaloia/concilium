/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { AgentInstance } from '../domain/agent/agent-config.js';
import { PROVIDER_IDS, type AgentProviderType } from '../domain/agent/providers.js';
import type { CouncilConfig } from '../domain/council/council-config.js';
import { parseCouncilMember, resolveCouncil } from '../domain/council/council-members.js';
import type { ConfigStore } from '../ports/config-store.js';
import type { DeliberationEvents } from '../ports/deliberation-events.js';
import type { CliDetection, HeadlessCliDriver } from '../ports/headless-cli-driver.js';
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

/** Which agent CLI logins Concilium supports, and why. `concilium doctor` prints it too. */
export const TERMS_OF_USE_URL = 'https://github.com/matiasdaloia/concilium/blob/main/docs/research/subscription-tos.md';

export const NO_AGENT_CLI_MESSAGE =
  'No agent CLI is installed and signed in, so there is no default Stage 1 agent. ' +
  `Run \`concilium doctor\` to see what is missing, pick agents with --agents, and see ${TERMS_OF_USE_URL} for the supported logins.`;

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
  /**
   * One Stage 1 agent per registered CLI that is installed and signed in with a subscription or an API key, in
   * registry order, on the CLI's own default model. A CLI whose detection carries a warning is left out.
   * Rejects with `NO_AGENT_CLI_MESSAGE` when no CLI qualifies.
   */
  defaultAgentInstances(): Promise<AgentInstance[]>;
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

/** The registered CLIs, in registry order, whose detection passes `accept`. A CLI whose detection fails is left out. */
async function detectClis(
  drivers: ReadonlyMap<string, HeadlessCliDriver>,
  accept: (detection: CliDetection) => boolean,
): Promise<AgentProviderType[]> {
  const accepted = await Promise.all(
    PROVIDER_IDS.map(async (id) => {
      const detection = await drivers.get(id)?.detect().catch(() => undefined);
      return detection && accept(detection) ? id : null;
    }),
  );
  return accepted.filter((id): id is AgentProviderType => id !== null);
}

/** Installed and not signed out: usable as a juror or chairman. */
const usableCli = (d: CliDetection): boolean => d.installed && d.auth !== 'none';

/** Installed, known to be signed in, and with nothing that `concilium doctor` warns about. */
const defaultAgentCli = (d: CliDetection): boolean =>
  d.installed && (d.auth === 'subscription' || d.auth === 'api-key') && !d.warning;

/** The composition root shared by the CLI command, the CLI library entry point and the desktop app. */
export function createConciliumRuntime(adapters: ConciliumAdapters): ConciliumRuntime {
  const drivers = createDrivers();
  const configService = new ConfigService(adapters.configStore, adapters.secretStore);

  const runtime: ConciliumRuntime = {
    ...adapters,
    drivers,
    configService,
    modelDiscovery: new ModelDiscoveryService(drivers),
    async defaultAgentInstances() {
      const clis = await detectClis(drivers, defaultAgentCli);
      if (clis.length === 0) throw new Error(NO_AGENT_CLI_MESSAGE);
      log.info(`default agents: ${clis.join(', ')}`);
      return clis.map((provider) => ({ instanceId: crypto.randomUUID(), provider, model: '', enabled: true }));
    },
    async resolveCouncilConfig(overrides = {}) {
      const config = await configService.resolve(overrides);
      // Detecting CLIs spawns them, so only detect when a juror list or chairman is left to fill in.
      const usable = (spec: string) => !!config.openRouterApiKey || parseCouncilMember(spec).kind === 'cli';
      const needsDefaults = !config.councilModels.some(usable) || !(config.chairmanModel && usable(config.chairmanModel));
      const council = resolveCouncil({
        councilModels: config.councilModels,
        chairmanModel: config.chairmanModel,
        usableClis: needsDefaults ? await detectClis(drivers, usableCli) : [],
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
