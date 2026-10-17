/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { AgentInstance } from '../domain/agent/agent-config.js';
import { PROVIDER_IDS, type AgentProviderType } from '../domain/agent/providers.js';
import type { CouncilConfig } from '../domain/council/council-config.js';
import { parseCouncilMember, resolveCouncil } from '../domain/council/council-members.js';
import {
  pickRole, resolveAllowSameFamily, resolveCodeRoles, resolveVerifierRole, type CodeRoleMap, type RoleMap, type RoleSettings, type VerifierRole,
} from '../domain/roles/roles.js';
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
import { readRepoRoles } from './role-service.js';

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
  resolveCouncilConfig(overrides?: Partial<CouncilConfig>, options?: RepoOptions): Promise<{ config: CouncilConfig; notes: string[] }>;
  /**
   * Resolve the council config once, build the council gateway from it (agent CLIs, plus OpenRouter when an API
   * key is configured), and return a service that runs with that config and reports progress to `events`.
   */
  createDeliberationService(
    events: DeliberationEvents,
    overrides?: Partial<CouncilConfig>,
    options?: RepoOptions,
  ): Promise<DeliberationService>;
  /**
   * The code roles of a run in `repoDir`. Per role, highest first: `flags` (`--role`, `--agents`), the repo's
   * `.concilium/factory.yaml` (read now), saved config, defaults. The default implementers are
   * `defaultAgentInstances()`, detected only when no source names them; the planner defaults to the first
   * implementer. Rejects with a `RolesValidationError` when a source is invalid.
   */
  resolveCodeRoles(input: { repoDir: string; flags?: RoleSettings }): Promise<CodeRoleMap>;
  /**
   * Every role, the plan council's jurors and chairman included (flag, env, repo, saved, default), and the
   * `factory.yaml` it read. Never rejects for a missing agent CLI: that is a note.
   */
  resolveRoleMap(input: { repoDir: string; flags?: RoleSettings }): Promise<{ roles: RoleMap; factoryPath: string | null; notes: string[] }>;
  /**
   * The verifier `concilium pr` and `verify-pr` prefer: flag, the repo's `factory.yaml` (read now), saved, else
   * `auto`; and the same-family opt-in the same way (`allowSameFamily`: the `--allow-same-family-verifier` flag, set
   * only when given), default false.
   */
  resolveVerifier(input: { repoDir: string; flags?: RoleSettings; allowSameFamily?: boolean }): Promise<VerifierRole>;
}

/** Where to look for `.concilium/factory.yaml`, whose `juror` and `chairman` roles rank between env vars and saved config. */
export type RepoOptions = { repoDir?: string };

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
    async resolveCouncilConfig(overrides = {}, options = {}) {
      return resolveCouncilWith(overrides, options.repoDir ? (await readRepoRoles(options.repoDir)).roles : {});
    },
    async createDeliberationService(events, overrides = {}, options = {}) {
      const { config, notes } = await runtime.resolveCouncilConfig(overrides, options);
      const openRouter = config.openRouterApiKey ? new OpenRouterGateway(config.openRouterApiKey, config.openRouterApiUrl) : null;
      const llmGateway = new CliCouncilGateway({ drivers, openRouter });
      return new DeliberationService({ runRepository: adapters.runRepository, drivers, llmGateway, config, events, councilNotes: notes });
    },
    async resolveCodeRoles({ repoDir, flags = {} }) {
      return codeRolesWith(flags, (await readRepoRoles(repoDir)).roles);
    },
    async resolveRoleMap({ repoDir, flags = {} }) {
      const { path, roles: repo } = await readRepoRoles(repoDir);
      const notes: string[] = [];
      const code = await codeRolesWith(flags, repo).catch(async (err: unknown) => {
        if (!(err instanceof Error) || err.message !== NO_AGENT_CLI_MESSAGE) throw err;
        notes.push(NO_AGENT_CLI_MESSAGE);
        return codeRolesWith(flags, repo, []);
      });
      const overrides: Partial<CouncilConfig> = {
        ...(Array.isArray(flags.juror) ? { councilModels: flags.juror } : {}),
        ...(typeof flags.chairman === 'string' ? { chairmanModel: flags.chairman } : {}),
      };
      const council = await resolveCouncilWith(overrides, repo);
      notes.push(...council.notes);
      return {
        roles: {
          ...code,
          verifier: resolveVerifierRole(await roleLayers(flags, repo)),
          juror: { value: council.config.councilModels, source: council.sources.councilModels },
          chairman: { value: council.config.chairmanModel, source: council.sources.chairmanModel },
        },
        factoryPath: path,
        notes,
      };
    },
    async resolveVerifier({ repoDir, flags = {}, allowSameFamily }) {
      const repo = await readRepoRoles(repoDir);
      return {
        ...resolveVerifierRole(await roleLayers(flags, repo.roles)),
        allowSameFamily: resolveAllowSameFamily([
          ['flag', allowSameFamily], ['repo', repo.allowSameFamilyVerifier], ['saved', await configService.savedAllowSameFamilyVerifier()],
        ]),
      };
    },
  };

  async function roleLayers(flags: RoleSettings, repo: RoleSettings) {
    return [['flag', flags], ['repo', repo], ['saved', await configService.savedRoles()]] as const;
  }

  /** `detected` stands in for detection, which `defaultAgentInstances` runs only when no source names the implementers. */
  async function codeRolesWith(flags: RoleSettings, repo: RoleSettings, detected?: string[]): Promise<CodeRoleMap> {
    const layers = await roleLayers(flags, repo);
    const implementers = detected ?? (pickRole('implementer', layers) ? [] : (await runtime.defaultAgentInstances()).map((a) => a.provider));
    return resolveCodeRoles(layers, () => implementers);
  }

  async function resolveCouncilWith(overrides: Partial<CouncilConfig>, repo: RoleSettings) {
    const { config, sources } = await configService.resolveWithSources(overrides, repo);
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
    return { config: { ...config, councilModels: council.councilModels, chairmanModel: council.chairmanModel }, notes: council.notes, sources };
  }

  return runtime;
}
