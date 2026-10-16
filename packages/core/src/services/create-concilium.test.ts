/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_IDS, PROVIDERS } from '../domain/agent/providers.js';
import type { CliDetection, HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import { FakeCliDriver } from '../adapters/cli/fake-cli-driver.js';
import { JsonConfigStore } from '../adapters/json-config-store.js';
import { JsonRunRepository } from '../adapters/json-run-repository.js';
import { PlaintextSecretStore } from '../adapters/plaintext-secret-store.js';
import { setLogLevel } from '../shared/logger.js';
import { createConciliumRuntime, createDrivers, NO_AGENT_CLI_MESSAGE } from './create-concilium.js';
import { ModelDiscoveryService } from './model-discovery-service.js';

describe('provider registry', () => {
  let dir: string;

  beforeAll(() => setLogLevel('error'));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'concilium-registry-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function storedInstances(providers: string[]): Promise<string[]> {
    const agentInstances = providers.map((provider, i) => ({
      instanceId: `id-${i}`,
      provider,
      model: '',
      enabled: true,
    }));
    await writeFile(join(dir, 'preferences.json'), JSON.stringify({ agentInstances }));
    const loaded = await new JsonConfigStore(dir).getAgentInstances();
    return loaded.map((inst) => inst.instanceId);
  }

  it('should register claude, codex, gemini and opencode', () => {
    expect(PROVIDER_IDS).toEqual(['claude', 'codex', 'gemini', 'opencode']);
  });

  it('should build one CLI driver per registry entry, in registry order', () => {
    const drivers = createDrivers({ PATH: '' });
    expect([...drivers.keys()]).toEqual(PROVIDER_IDS);
    for (const [id, driver] of drivers) {
      expect(driver.id).toBe(id);
    }
  });

  it('should accept every registered provider in saved agent instances', async () => {
    const ids = await storedInstances([...PROVIDER_IDS]);
    expect(ids).toEqual(PROVIDER_IDS.map((_, i) => `id-${i}`));
  });

  it('should drop saved agent instances whose provider is not registered', async () => {
    const ids = await storedInstances([...PROVIDER_IDS, 'not-a-provider']);
    expect(ids).not.toContain(`id-${PROVIDER_IDS.length}`);
  });

  it('should load no agent instances when fewer than two valid ones are saved', async () => {
    expect(await new JsonConfigStore(dir).getAgentInstances()).toEqual([]);
    expect(await storedInstances(['claude'])).toEqual([]);
  });

  /** A runtime whose drivers are fakes with the given detections; CLIs left out are not installed. */
  function runtimeWith(detections: Partial<Record<string, CliDetection>>) {
    const runtime = createConciliumRuntime({
      configStore: new JsonConfigStore(dir),
      secretStore: new PlaintextSecretStore(),
      runRepository: new JsonRunRepository(dir),
    });
    for (const id of PROVIDER_IDS) {
      runtime.drivers.set(id, new FakeCliDriver({ id, detection: detections[id] ?? { installed: false } }));
    }
    return runtime;
  }

  it('should default to one agent per installed, signed-in CLI, in registry order', async () => {
    const runtime = runtimeWith({
      opencode: { installed: true, auth: 'api-key' },
      gemini: { installed: true, auth: 'api-key' },
      codex: { installed: true, auth: 'none' },
      claude: { installed: true, auth: 'subscription' },
    });

    const agents = await runtime.defaultAgentInstances();

    expect(agents.map((a) => a.provider)).toEqual(['claude', 'gemini', 'opencode']);
    for (const agent of agents) expect(agent).toMatchObject({ model: '', enabled: true });
    expect(new Set(agents.map((a) => a.instanceId)).size).toBe(agents.length);
  });

  it('should leave out CLIs with an unknown login and CLIs doctor warns about', async () => {
    const runtime = runtimeWith({
      claude: { installed: true, auth: 'subscription' },
      gemini: { installed: true, auth: 'unknown' },
      opencode: { installed: true, auth: 'subscription', warning: 'Anthropic terms do not cover Claude subscription login in OpenCode' },
    });

    expect((await runtime.defaultAgentInstances()).map((a) => a.provider)).toEqual(['claude']);
  });

  it('should leave out a CLI whose detection fails', async () => {
    const runtime = runtimeWith({ codex: { installed: true, auth: 'subscription' } });
    runtime.drivers.set('claude', Object.assign(new FakeCliDriver({ id: 'claude' }), {
      detect: async (): Promise<CliDetection> => {
        throw new Error('probe failed');
      },
    }));

    expect((await runtime.defaultAgentInstances()).map((a) => a.provider)).toEqual(['codex']);
  });

  it('should reject with a pointer to doctor and the terms doc when no CLI is signed in', async () => {
    const runtime = runtimeWith({ codex: { installed: true, auth: 'none' }, gemini: { installed: true, auth: 'unknown' } });

    await expect(runtime.defaultAgentInstances()).rejects.toThrow(NO_AGENT_CLI_MESSAGE);
    expect(NO_AGENT_CLI_MESSAGE).toContain('concilium doctor');
    expect(NO_AGENT_CLI_MESSAGE).toContain('docs/research/subscription-tos.md');
  });

  it('should offer the registry models, and the models OpenCode lists itself', async () => {
    const opencode = Object.assign(new FakeCliDriver({ id: 'opencode' }), { listModels: async () => ['openai/gpt-5.2'] });
    const drivers = new Map<string, HeadlessCliDriver>([
      ['claude', new FakeCliDriver({ id: 'claude' })],
      ['gemini', new FakeCliDriver({ id: 'gemini' })],
      ['opencode', opencode],
    ]);

    const models = await new ModelDiscoveryService(drivers).discoverAll();

    const registry = (id: string) => PROVIDERS.find((p) => p.id === id)!;
    expect(models).toEqual([
      { id: 'claude', models: [...registry('claude').models], defaultModel: 'claude-opus-4-6', supportsDiscovery: false },
      { id: 'gemini', models: [...registry('gemini').models], defaultModel: '', supportsDiscovery: false },
      { id: 'opencode', models: ['openai/gpt-5.2'], defaultModel: '', supportsDiscovery: true },
    ]);
  });

  it('should offer no OpenCode models when listing them fails', async () => {
    const opencode = Object.assign(new FakeCliDriver({ id: 'opencode' }), {
      listModels: async (): Promise<string[]> => {
        throw new Error('opencode not installed');
      },
    });

    const [info] = await new ModelDiscoveryService(new Map([['opencode', opencode]])).discoverAll();

    expect(info).toMatchObject({ id: 'opencode', models: [] });
  });
});
