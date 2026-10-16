/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { PROVIDER_IDS } from "@concilium/core/providers";
import type { AgentProvider } from "./types";

/**
 * Renderer display color for each provider in core's registry.
 * Keyed by the registry's provider type, so adding a provider to core fails
 * to compile here until it has a color.
 */
const PROVIDER_COLORS = {
  claude: "var(--color-provider-claude)",
  codex: "var(--color-provider-codex)",
  gemini: "var(--color-provider-gemini)",
  opencode: "var(--color-provider-opencode)",
} satisfies Record<AgentProvider, string>;

/** Providers in core's registry order, the same order the CLI uses. */
export const PROVIDER_OPTIONS: { id: AgentProvider; name: string; color: string }[] =
  PROVIDER_IDS.map((id) => ({
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
