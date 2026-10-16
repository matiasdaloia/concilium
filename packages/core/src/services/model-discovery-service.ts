/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { AgentModelInfo } from '../domain/agent/agent-executor.js';
import { PROVIDERS } from '../domain/agent/providers.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('model-discovery');

export class ModelDiscoveryService {
  constructor(private drivers: ReadonlyMap<string, HeadlessCliDriver>) {}

  /** The models of every provider that has a driver, in registry order. Listed by the CLI where it can, else the registry's list. */
  async discoverAll(): Promise<AgentModelInfo[]> {
    const results: AgentModelInfo[] = [];

    for (const info of PROVIDERS) {
      const driver = this.drivers.get(info.id);
      if (!driver) continue;
      let models: string[] = [...info.models];
      if (info.supportsDiscovery) {
        try {
          models = (await driver.listModels?.()) ?? [];
        } catch (err) {
          log.warn(`discoverAll: failed for ${info.id}:`, err instanceof Error ? err.message : String(err));
          models = [];
        }
      }
      results.push({ id: info.id, models, defaultModel: info.defaultModel, supportsDiscovery: info.supportsDiscovery });
    }

    return results;
  }
}
