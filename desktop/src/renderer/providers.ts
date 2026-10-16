/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { AgentProvider } from "./types";

/**
 * Renderer display data for each provider in core's registry, in menu order.
 * Keyed by the registry's provider type, so adding a provider to core fails
 * to compile here until it has a color.
 */
const PROVIDER_COLORS = {
  opencode: "var(--color-provider-opencode)",
  codex: "var(--color-provider-codex)",
  claude: "var(--color-provider-claude)",
} satisfies Record<AgentProvider, string>;

export const PROVIDER_OPTIONS: { id: AgentProvider; name: string; color: string }[] =
  (Object.keys(PROVIDER_COLORS) as AgentProvider[]).map((id) => ({
    id,
    name: id,
    color: PROVIDER_COLORS[id],
  }));

export function getProviderColor(provider: AgentProvider): string {
  return PROVIDER_COLORS[provider] ?? "var(--color-text-muted)";
}

/** An empty model list per provider, before discovery fills them in. */
export function emptyModelOptions(): Record<string, string[]> {
  return Object.fromEntries(PROVIDER_OPTIONS.map((p) => [p.id, []]));
}
