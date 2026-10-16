/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '../domain/agent/providers.js';
import { JsonConfigStore } from '../adapters/json-config-store.js';
import { createProviders } from './create-concilium.js';

describe('provider registry', () => {
  let dir: string;

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

  it('should build one provider per registry entry, in registry order', () => {
    const providers = createProviders();
    expect([...providers.keys()]).toEqual(PROVIDER_IDS);
    for (const [id, provider] of providers) {
      expect(provider.id).toBe(id);
    }
  });

  it('should build only the requested providers and ignore unknown ids', () => {
    expect([...createProviders(['codex', 'not-a-provider']).keys()]).toEqual(['codex']);
  });

  it('should accept every registered provider in saved agent instances', async () => {
    const ids = await storedInstances([...PROVIDER_IDS]);
    expect(ids).toEqual(PROVIDER_IDS.map((_, i) => `id-${i}`));
  });

  it('should drop saved agent instances whose provider is not registered', async () => {
    const ids = await storedInstances([...PROVIDER_IDS, 'not-a-provider']);
    expect(ids).not.toContain(`id-${PROVIDER_IDS.length}`);
  });
});
