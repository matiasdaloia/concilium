/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { getProviderInfo, isProviderId, PROVIDERS, type AgentProviderType } from '../agent/providers.js';

/**
 * A juror or chairman. `claude`, `codex:gpt-5.2` or `opencode:openai/gpt-5.2` run through that agent CLI
 * (`cli[:model]`, no model = the CLI's default). Anything else is an OpenRouter model id such as `openai/gpt-5.2`.
 */
export type CouncilMember =
  | { kind: 'cli'; cli: AgentProviderType; model?: string }
  | { kind: 'openrouter'; model: string };

export function parseCouncilMember(spec: string): CouncilMember {
  const trimmed = spec.trim();
  const colon = trimmed.indexOf(':');
  const head = colon === -1 ? trimmed : trimmed.slice(0, colon);
  if (!isProviderId(head)) return { kind: 'openrouter', model: trimmed };
  const model = colon === -1 ? '' : trimmed.slice(colon + 1).trim();
  return { kind: 'cli', cli: head, ...(model && { model }) };
}

const OPENROUTER_VENDOR_FAMILY: Record<string, string> = { anthropic: 'anthropic', openai: 'openai', google: 'google' };

/** The model family a member runs on, or null when it is unknown (OpenCode without a model). */
export function memberFamily(member: CouncilMember): string | null {
  if (member.kind === 'openrouter') {
    const vendor = member.model.split('/')[0];
    return OPENROUTER_VENDOR_FAMILY[vendor] ?? vendor;
  }
  const family = getProviderInfo(member.cli)?.family ?? null;
  if (family || !member.model?.includes('/')) return family;
  return memberFamily({ kind: 'openrouter', model: member.model });
}

/** Ties for the chairman seat go to the first CLI here (Gemini was the chairman of the OpenRouter defaults). */
const CHAIRMAN_TIE_ORDER: readonly AgentProviderType[] = ['gemini', 'codex', 'claude', 'opencode'];

/** `notes` explain configured members that were dropped, or that no juror is left. */
export type ResolvedCouncil = { councilModels: string[]; chairmanModel: string; notes: string[] };

/**
 * Fills in the jurors and chairman a run uses. Configured members are kept, except OpenRouter ones without an
 * API key. Missing jurors default to every usable CLI with a known model family (OpenCode only when no other CLI
 * is usable). A missing chairman defaults to the usable CLI whose family holds the fewest juror seats, so it comes
 * from another family than most jurors when one is available.
 */
export function resolveCouncil(input: {
  councilModels: string[];
  chairmanModel: string;
  /** Installed and signed-in CLIs, in registry order. */
  usableClis: readonly AgentProviderType[];
  hasOpenRouterKey: boolean;
}): ResolvedCouncil {
  const notes: string[] = [];
  const keep = (spec: string, role: string): boolean => {
    if (input.hasOpenRouterKey || parseCouncilMember(spec).kind === 'cli') return true;
    notes.push(`OpenRouter ${role} ${spec} skipped: no OpenRouter API key is configured.`);
    return false;
  };

  const usable = PROVIDERS.map((p) => p.id).filter((id) => input.usableClis.includes(id));
  const withFamily = usable.filter((id) => getProviderInfo(id)?.family);
  const pool = withFamily.length > 0 ? withFamily : usable;

  let councilModels = input.councilModels.map((s) => s.trim()).filter((spec) => spec && keep(spec, 'juror'));
  if (councilModels.length === 0) councilModels = [...pool];

  let chairmanModel = input.chairmanModel.trim();
  if (chairmanModel && !keep(chairmanModel, 'chairman')) chairmanModel = '';
  if (!chairmanModel) {
    const seats = (id: AgentProviderType) => {
      const family = getProviderInfo(id)?.family ?? id;
      return councilModels.filter((spec) => (memberFamily(parseCouncilMember(spec)) ?? spec) === family).length;
    };
    const byTieOrder = [...pool].sort((a, b) => CHAIRMAN_TIE_ORDER.indexOf(a) - CHAIRMAN_TIE_ORDER.indexOf(b));
    const fewest = Math.min(...byTieOrder.map(seats));
    chairmanModel = byTieOrder.find((id) => seats(id) === fewest) ?? councilModels[0] ?? '';
  }

  if (councilModels.length === 0) {
    notes.push('No juror is available: install and sign in to claude, codex, gemini or opencode, or configure OpenRouter jurors and an API key.');
  }
  return { councilModels, chairmanModel, notes };
}
