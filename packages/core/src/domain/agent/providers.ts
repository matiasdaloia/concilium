/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

/**
 * The provider registry: every agent CLI Concilium knows about.
 * Pure data with no Node imports, so the desktop renderer can import it
 * through the `@concilium/core/providers` subpath.
 * Each id has a headless CLI driver in `adapters/cli/cli-drivers.ts`.
 *
 * `family` is the model family the CLI runs on its own login, used to seat a chairman
 * from another family than the jurors. OpenCode routes to any provider, so it has none: its family comes
 * from the model id (`agentFamily`).
 * `models` is the fixed model list offered for CLIs that cannot list their models
 * (`supportsDiscovery: false`); an empty `defaultModel` means the CLI's own default.
 */
export const PROVIDERS = [
  {
    id: 'claude',
    displayName: 'Claude',
    family: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    models: ['sonnet', 'opus', 'haiku', 'claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
    supportsDiscovery: false,
  },
  {
    id: 'codex',
    displayName: 'Codex',
    family: 'openai',
    defaultModel: 'gpt-5.2-codex',
    models: ['gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5-codex', 'gpt-5-codex-mini', 'o3-codex'],
    supportsDiscovery: false,
  },
  {
    id: 'gemini',
    displayName: 'Gemini',
    family: 'google',
    defaultModel: '',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro-preview'],
    supportsDiscovery: false,
  },
  { id: 'opencode', displayName: 'OpenCode', family: null, defaultModel: '', models: [], supportsDiscovery: true },
] as const;

export type ProviderInfo = (typeof PROVIDERS)[number];
export type AgentProviderType = ProviderInfo['id'];

export const PROVIDER_IDS: readonly AgentProviderType[] = PROVIDERS.map((p) => p.id);

export function isProviderId(value: unknown): value is AgentProviderType {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function getProviderInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Model vendors whose family is known: the families of the CLIs above. Any other vendor is an unknown family. */
export const VENDOR_FAMILY: Readonly<Record<string, string>> = { anthropic: 'anthropic', openai: 'openai', google: 'google' };

/**
 * The model family an agent runs on, or null when it is unknown. Every family check uses it: the judge, the
 * adversaries, the verifier, the role rules and the ledger. A CLI with a family (`claude`, `codex`, `gemini`) has
 * it whatever the model. OpenCode's comes from its model id: `<vendor>/<model>` (`google/gemini-2.5-pro`), or
 * `<provider>/<vendor>/<model>` through a router (`openrouter/anthropic/claude-sonnet-4.5`), for a vendor in
 * `VENDOR_FAMILY`; any other vendor, or no model, is unknown.
 */
export function agentFamily(provider: string, model?: string | null): string | null {
  const family = getProviderInfo(provider)?.family ?? null;
  if (family !== null || !model) return family;
  const [first, second, ...rest] = model.trim().split('/');
  if (second === undefined) return null;
  return VENDOR_FAMILY[first] ?? (rest.length > 0 ? VENDOR_FAMILY[second] ?? null : null);
}

/** The family an agent counts toward: its model family, or its provider id when that is unknown. */
export function familyKey(provider: string, model?: string | null): string {
  return agentFamily(provider, model) ?? provider;
}
