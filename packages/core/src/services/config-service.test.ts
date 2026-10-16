/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliberationEvents } from '../ports/deliberation-events.js';
import type { CouncilConfig } from '../domain/council/council-config.js';
import { OPENROUTER_API_URL } from '../domain/council/council-config.js';
import type { RunRecord } from '../domain/run/run-record.js';
import { COUNCIL_PROMPT_FILE } from '../adapters/cli/cli-council-gateway.js';
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
 *   Jurors:    override (`--juror-models`, `councilModels`) > COUNCIL_MODELS     > saved config (`config set jurors`)   > [] (installed CLIs)
 *   Chairman:  override (`--chairman`, `chairmanModel`)     > CHAIRMAN_MODEL     > saved config (`config set chairman`) > '' (installed CLIs)
 *
 * The runtime fills an empty juror list or chairman from the installed agent CLIs (see council-members.test.ts).
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

  it('should leave the jurors and chairman to the installed CLIs and need no key when nothing is configured', async () => {
    expect(await service().resolve()).toEqual({
      openRouterApiKey: '',
      openRouterApiUrl: OPENROUTER_API_URL,
      councilModels: [],
      chairmanModel: '',
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

    expect((await service().resolve()).chairmanModel).toBe('');
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

  it('should judge and synthesize through the installed CLIs when nothing is configured and no key is set', async () => {
    const { models, record } = await runThroughRuntime({});

    expect(models).toEqual([]);
    expect(record.stage2.map((r) => r.model)).toEqual(['claude', 'codex', 'gemini']);
    expect(record.stage3).toMatchObject({ model: 'gemini', response: 'CLI synthesis' });
    expect(record.metadata.notes).toBeUndefined();
  });

  it('should replace saved OpenRouter jurors with the installed CLIs when no key is set, and say so', async () => {
    await service().saveCouncilConfig({ councilModels: ['saved/j1'], chairmanModel: 'claude:opus' });

    const { models, record } = await runThroughRuntime({});

    expect(models).toEqual([]);
    expect(record.stage2.map((r) => r.model)).toEqual(['claude', 'codex', 'gemini']);
    expect(record.stage3?.model).toBe('claude:opus');
    expect(record.metadata.notes).toEqual(['OpenRouter juror saved/j1 skipped: no OpenRouter API key is configured.']);
  });

  /**
   * Runs two fake agents through `createConciliumRuntime` with the given overrides. Every driver is a fake:
   * claude, codex and gemini are installed and signed in, opencode is not installed.
   * Returns the run and what OpenRouter received.
   */
  async function runThroughRuntime(overrides: Partial<CouncilConfig>): Promise<OpenRouterRequests & { record: RunRecord }> {
    const requests = stubOpenRouter();
    const runtime = createConciliumRuntime({
      configStore,
      secretStore,
      runRepository: new JsonRunRepository(join(dir, 'data')),
    });
    for (const id of ['claude', 'codex', 'gemini']) runtime.drivers.set(id, fakeCli(id));
    runtime.drivers.set('opencode', new FakeCliDriver({ id: 'opencode', detection: { installed: false } }));

    const deliberation = await runtime.createDeliberationService(silentEvents(), overrides);
    const record = await deliberation.run({
      prompt: 'task',
      cwd: dir,
      agentInstances: [
        { instanceId: 'a', provider: 'claude', model: '', enabled: true },
        { instanceId: 'b', provider: 'codex', model: '', enabled: true },
      ],
    });
    return { ...requests, record };
  }
});

/** A fake agent CLI: a plan as a Stage 1 agent; as a juror it ranks Response A first, as the chairman it answers "CLI synthesis". */
function fakeCli(id: string): FakeCliDriver {
  return new FakeCliDriver({
    id,
    respond: (brief) => {
      if (!brief.task.includes(COUNCIL_PROMPT_FILE)) return [{ type: 'text', text: `Plan from ${id}` }];
      const prompt = readFileSync(join(brief.cwd, COUNCIL_PROMPT_FILE), 'utf8');
      const ranking = prompt.includes('provide your code review and ranking');
      return [{ type: 'text', text: ranking ? 'FINAL RANKING:\n1. Response A\n2. Response B' : 'CLI synthesis' }];
    },
  });
}

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
