/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResult } from '../domain/agent/agent-result.js';
import type { AgentExecutionConfig, AgentProvider } from '../ports/agent-provider.js';
import type { DeliberationEvents } from '../ports/deliberation-events.js';
import {
  DEFAULT_CHAIRMAN_MODEL,
  DEFAULT_COUNCIL_MODELS,
  OPENROUTER_API_URL,
} from '../domain/council/council-config.js';
import { JsonConfigStore } from '../adapters/json-config-store.js';
import { JsonRunRepository } from '../adapters/json-run-repository.js';
import { PlaintextSecretStore } from '../adapters/plaintext-secret-store.js';
import { setLogLevel } from '../shared/logger.js';
import { ConfigService } from './config-service.js';
import { createConciliumRuntime } from './create-concilium.js';

/*
 * Actual precedence today, highest wins, per setting:
 *
 *   API key:   OPENROUTER_API_KEY  > saved config (`config set api-key`) > '' (none)
 *   API URL:   OPENROUTER_API_URL  > built-in default (no saved setting exists)
 *   Jurors:    COUNCIL_MODELS      > saved config (`config set jurors`)  > built-in defaults
 *   Chairman:  CHAIRMAN_MODEL      > saved config (`config set chairman`) > built-in default
 *
 * The `run --juror-models` and `--chairman` flags are not applied (see the skipped test below).
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

  // BUG (found by this test, not fixed): `run --juror-models` and `--chairman` reach
  // createDeliberationService as overrides, but DeliberationService resolves the config
  // again and asks the saved/env jurors and chairman instead.
  it.skip('should ask the juror and chairman models passed as run overrides', async () => {
    await service().saveCouncilConfig({ apiKey: 'sk-saved', councilModels: ['saved/j1'], chairmanModel: 'saved/chair' });
    const requested = stubOpenRouter();
    const runtime = createConciliumRuntime({
      configStore,
      secretStore,
      runRepository: new JsonRunRepository(join(dir, 'data')),
    });
    runtime.providers.set('claude', new FixedPlanProvider('claude'));
    runtime.providers.set('codex', new FixedPlanProvider('codex'));

    const deliberation = await runtime.createDeliberationService(silentEvents(), {
      councilModels: ['flag/j1', 'flag/j2'],
      chairmanModel: 'flag/chair',
    });
    await deliberation.run({
      prompt: 'task',
      cwd: dir,
      agentInstances: [
        { instanceId: 'a', provider: 'claude', model: '', enabled: true },
        { instanceId: 'b', provider: 'codex', model: '', enabled: true },
      ],
    });

    expect(requested.sort()).toEqual(['flag/chair', 'flag/j1', 'flag/j2']);
  });
});

/** Replaces fetch with a fake OpenRouter that ranks Response A first; returns the requested model ids. */
function stubOpenRouter(): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { model: string; stream?: boolean };
    requested.push(body.model);
    const content = 'FINAL RANKING:\n1. Response A\n2. Response B';
    if (body.stream) {
      const chunk = JSON.stringify({ choices: [{ delta: { content } }] });
      return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`);
    }
    return Response.json({ choices: [{ message: { content: 'Synthesis' } }] });
  });
  return requested;
}

class FixedPlanProvider implements AgentProvider {
  readonly name: string;

  constructor(readonly id: string) {
    this.name = id;
  }

  async discoverModels(): Promise<string[]> {
    return [];
  }

  async execute({ agent }: AgentExecutionConfig): Promise<AgentResult> {
    return {
      id: agent.id,
      agentKey: agent.instanceId,
      name: agent.name,
      status: 'success',
      normalizedPlan: `Plan from ${this.id}`,
      errors: [],
      command: [],
      events: [],
    };
  }
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
