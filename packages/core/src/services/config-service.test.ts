/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliberationEvents } from '../ports/deliberation-events.js';
import type { CouncilConfig } from '../domain/council/council-config.js';
import {
  DEFAULT_CHAIRMAN_MODEL,
  DEFAULT_COUNCIL_MODELS,
  OPENROUTER_API_URL,
} from '../domain/council/council-config.js';
import { FakeCliDriver } from '../adapters/cli/fake-cli-driver.js';
import { JsonConfigStore } from '../adapters/json-config-store.js';
import { JsonRunRepository } from '../adapters/json-run-repository.js';
import { PlaintextSecretStore } from '../adapters/plaintext-secret-store.js';
import { setLogLevel } from '../shared/logger.js';
import { ConfigService } from './config-service.js';
import { createConciliumRuntime } from './create-concilium.js';

/*
 * Precedence, highest wins, per setting. Overrides are `run` flags and `deliberate()` options.
 *
 *   API key:   override (`apiKey`)                   > OPENROUTER_API_KEY > saved config (`config set api-key`)  > '' (none)
 *   API URL:   OPENROUTER_API_URL > built-in default (no flag or saved setting exists)
 *   Jurors:    override (`--juror-models`, `councilModels`) > COUNCIL_MODELS     > saved config (`config set jurors`)   > built-in defaults
 *   Chairman:  override (`--chairman`, `chairmanModel`)     > CHAIRMAN_MODEL     > saved config (`config set chairman`) > built-in default
 */

const ENV_VARS = ['OPENROUTER_API_KEY', 'OPENROUTER_API_URL', 'COUNCIL_MODELS', 'CHAIRMAN_MODEL'] as const;

describe('ConfigService.resolve precedence', () => {
  let dir: string;
  let configStore: JsonConfigStore;
  const secretStore = new PlaintextSecretStore();

  beforeAll(() => setLogLevel('error'));

  beforeEach(async () => {
    for (const name of ENV_VARS) vi.stubEnv(name, '');
    dir = await mkdtemp(join(tmpdir(), 'concilium-config-'));
    configStore = new JsonConfigStore(dir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  const service = () => new ConfigService(configStore, secretStore);

  it('should use the built-in defaults when nothing is configured', async () => {
    expect(await service().resolve()).toEqual({
      openRouterApiKey: '',
      openRouterApiUrl: OPENROUTER_API_URL,
      councilModels: DEFAULT_COUNCIL_MODELS,
      chairmanModel: DEFAULT_CHAIRMAN_MODEL,
    });
  });

  it('should prefer the saved config over the defaults', async () => {
    await service().saveCouncilConfig({ apiKey: 'sk-saved', councilModels: ['saved/j1', 'saved/j2'], chairmanModel: 'saved/chair' });

    expect(await service().resolve()).toEqual({
      openRouterApiKey: 'sk-saved',
      openRouterApiUrl: OPENROUTER_API_URL,
      councilModels: ['saved/j1', 'saved/j2'],
      chairmanModel: 'saved/chair',
    });
  });

  it('should prefer environment variables over the saved config', async () => {
    await service().saveCouncilConfig({ apiKey: 'sk-saved', councilModels: ['saved/j1'], chairmanModel: 'saved/chair' });
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-env');
    vi.stubEnv('OPENROUTER_API_URL', 'http://localhost:9/v1/chat');
    vi.stubEnv('COUNCIL_MODELS', ' env/j1 , env/j2 ,');
    vi.stubEnv('CHAIRMAN_MODEL', 'env/chair');

    expect(await service().resolve()).toEqual({
      openRouterApiKey: 'sk-env',
      openRouterApiUrl: 'http://localhost:9/v1/chat',
      councilModels: ['env/j1', 'env/j2'],
      chairmanModel: 'env/chair',
    });
  });

  it('should fall through each setting independently', async () => {
    await service().saveCouncilConfig({ councilModels: ['saved/j1'] });
    vi.stubEnv('CHAIRMAN_MODEL', 'env/chair');

    const resolved = await service().resolve();

    expect(resolved.councilModels).toEqual(['saved/j1']);
    expect(resolved.chairmanModel).toBe('env/chair');
    expect(resolved.openRouterApiKey).toBe('');
  });

  it('should reset to the defaults after the saved config is cleared', async () => {
    await service().saveCouncilConfig({ councilModels: ['saved/j1'], chairmanModel: 'saved/chair' });
    await configStore.saveCouncilConfigPrefs({});

    expect((await service().resolve()).chairmanModel).toBe(DEFAULT_CHAIRMAN_MODEL);
  });

  it('should keep the other saved settings when one setting is saved', async () => {
    await service().saveApiKey('sk-saved');
    await service().saveCouncilConfig({ councilModels: ['saved/j1'] });
    await service().saveCouncilConfig({ chairmanModel: 'saved/chair' });

    expect(await service().resolve()).toMatchObject({
      openRouterApiKey: 'sk-saved',
      councilModels: ['saved/j1'],
      chairmanModel: 'saved/chair',
    });
  });

  it('should prefer explicit overrides over environment variables', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-env');
    vi.stubEnv('COUNCIL_MODELS', 'env/j1');
    vi.stubEnv('CHAIRMAN_MODEL', 'env/chair');

    const resolved = await service().resolve({ councilModels: ['flag/j1'], chairmanModel: 'flag/chair' });

    expect(resolved.councilModels).toEqual(['flag/j1']);
    expect(resolved.chairmanModel).toBe('flag/chair');
    expect(resolved.openRouterApiKey).toBe('sk-env');
  });

  it('should ask the juror and chairman models passed as run overrides', async () => {
    await service().saveCouncilConfig({ apiKey: 'sk-saved', councilModels: ['saved/j1'], chairmanModel: 'saved/chair' });
    vi.stubEnv('COUNCIL_MODELS', 'env/j1');
    vi.stubEnv('CHAIRMAN_MODEL', 'env/chair');

    const { models } = await runThroughRuntime({ councilModels: ['flag/j1', 'flag/j2'], chairmanModel: 'flag/chair' });

    expect(models.sort()).toEqual(['flag/chair', 'flag/j1', 'flag/j2']);
  });

  it('should judge with the API key passed as a run override when none is configured', async () => {
    await service().saveCouncilConfig({ councilModels: ['saved/j1'], chairmanModel: 'saved/chair' });

    const { models, authorizations } = await runThroughRuntime({ openRouterApiKey: 'sk-flag' });

    expect(models.sort()).toEqual(['saved/chair', 'saved/j1']);
    expect(new Set(authorizations)).toEqual(new Set(['Bearer sk-flag']));
  });

  /** Runs two fake agents through `createConciliumRuntime` with the given overrides; returns what OpenRouter received. */
  async function runThroughRuntime(overrides: Partial<CouncilConfig>): Promise<OpenRouterRequests> {
    const requests = stubOpenRouter();
    const runtime = createConciliumRuntime({
      configStore,
      secretStore,
      runRepository: new JsonRunRepository(join(dir, 'data')),
    });
    for (const id of ['claude', 'codex']) {
      runtime.drivers.set(id, new FakeCliDriver({ id, events: [{ type: 'text', text: `Plan from ${id}` }] }));
    }

    const deliberation = await runtime.createDeliberationService(silentEvents(), overrides);
    await deliberation.run({
      prompt: 'task',
      cwd: dir,
      agentInstances: [
        { instanceId: 'a', provider: 'claude', model: '', enabled: true },
        { instanceId: 'b', provider: 'codex', model: '', enabled: true },
      ],
    });
    return requests;
  }
});

type OpenRouterRequests = { models: string[]; authorizations: string[] };

/** Replaces fetch with a fake OpenRouter that ranks Response A first; records the requested models and auth headers. */
function stubOpenRouter(): OpenRouterRequests {
  const requested: OpenRouterRequests = { models: [], authorizations: [] };
  vi.stubGlobal('fetch', async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body) as { model: string; stream?: boolean };
    requested.models.push(body.model);
    requested.authorizations.push(init.headers.Authorization);
    const content = 'FINAL RANKING:\n1. Response A\n2. Response B';
    if (body.stream) {
      const chunk = JSON.stringify({ choices: [{ delta: { content } }] });
      return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`);
    }
    return Response.json({ choices: [{ message: { content: 'Synthesis' } }] });
  });
  return requested;
}

function silentEvents(): DeliberationEvents {
  const noop = () => {};
  return {
    onStageChange: noop,
    onAgentStatus: noop,
    onAgentEvent: noop,
    onJurorStatus: noop,
    onJurorChunk: noop,
    onJurorComplete: noop,
    onSynthesisStart: noop,
    onComplete: noop,
    onError: noop,
  };
}
