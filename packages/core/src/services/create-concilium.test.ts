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
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import { FakeCliDriver } from '../adapters/cli/fake-cli-driver.js';
import { JsonConfigStore } from '../adapters/json-config-store.js';
import { setLogLevel } from '../shared/logger.js';
import { createDrivers } from './create-concilium.js';
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
