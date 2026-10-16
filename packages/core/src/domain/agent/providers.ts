/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { AgentInstance } from './agent-config.js';

/**
 * The provider registry: every agent provider Concilium knows about.
 * Pure data with no Node imports, so the desktop renderer can import it.
 * Factories live in `services/create-concilium.ts`, keyed by these ids.
 */
export const PROVIDERS = [
  { id: 'claude', displayName: 'Claude', defaultModel: 'claude-opus-4-6', supportsDiscovery: false },
  { id: 'codex', displayName: 'Codex', defaultModel: 'gpt-5.2-codex', supportsDiscovery: false },
  { id: 'opencode', displayName: 'OpenCode', defaultModel: '', supportsDiscovery: true },
] as const;

export type ProviderInfo = (typeof PROVIDERS)[number];
export type AgentProviderType = ProviderInfo['id'];

export const PROVIDER_IDS: readonly AgentProviderType[] = PROVIDERS.map((p) => p.id);

/** Provider used for the default agent instances. */
export const DEFAULT_PROVIDER: AgentProviderType = 'opencode';

export function isProviderId(value: unknown): value is AgentProviderType {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function getProviderInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Two enabled instances of the default provider, with the provider's own model choice. */
export function createDefaultAgentInstances(): AgentInstance[] {
  return [
    { instanceId: crypto.randomUUID(), provider: DEFAULT_PROVIDER, model: '', enabled: true },
    { instanceId: crypto.randomUUID(), provider: DEFAULT_PROVIDER, model: '', enabled: true },
  ];
}
