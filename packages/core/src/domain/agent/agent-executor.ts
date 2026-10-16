/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { AgentConfig, AgentStatus } from './agent-config.js';
import type { AgentResult } from './agent-result.js';
import type { ParsedEvent } from './parsed-event.js';
import type { Brief } from '../driver/brief.js';
import type { RunEvent } from '../driver/normalized-event.js';
import type { Report } from '../driver/report.js';
import { wrapPromptForResearch } from '../deliberation/prompts.js';
import type { HeadlessCliDriver } from '../../ports/headless-cli-driver.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('agent-executor');

/** Wall-clock limit for one Stage 1 agent. */
export const AGENT_TIMEOUT_MS = 30 * 60_000;

export interface RunnerCallbacks {
  onStatus?: (agentKey: string, status: AgentStatus) => void;
  onEvent?: (agentKey: string, event: ParsedEvent) => void;
}

/** Cancels a whole run, or one agent of it, through abort signals. */
export class RunController {
  private readonly run = new AbortController();
  private readonly agents = new Map<string, AbortController>();

  /** Aborted when the whole run is cancelled. */
  get signal(): AbortSignal {
    return this.run.signal;
  }

  get isCancelled(): boolean {
    return this.run.signal.aborted;
  }

  /** The signal one agent runs under; it aborts when the agent or the run is cancelled. */
  register(agentKey: string): AbortSignal {
    const agent = new AbortController();
    this.agents.set(agentKey, agent);
    return AbortSignal.any([this.run.signal, agent.signal]);
  }

  unregister(agentKey: string): void {
    this.agents.delete(agentKey);
  }

  cancel(): void {
    this.run.abort();
  }

  cancelAgent(agentKey: string): boolean {
    const agent = this.agents.get(agentKey);
    if (!agent) return false;
    agent.abort();
    return true;
  }
}

/** The read-only plan brief every Stage 1 agent gets. Image files are listed for the agent to read. */
export function agentBrief(prompt: string, cwd: string, imagePaths: string[] = []): Brief {
  const images = imagePaths.length > 0 ? `\n\nAttached images (read these files):\n${imagePaths.map((p) => `- ${p}`).join('\n')}` : '';
  return {
    version: 1,
    task: wrapPromptForResearch(`${prompt}${images}`),
    mode: 'plan',
    cwd,
    constraints: [],
    allowedActions: ['read', 'network'],
  };
}

/** The event shape the CLI and desktop UIs and stored runs use. */
export function toParsedEvent(event: RunEvent): ParsedEvent {
  const rawLine = JSON.stringify(event);
  switch (event.type) {
    case 'text':
      return { eventType: 'text', text: event.text, rawLine };
    case 'tool':
      return { eventType: 'tool_call', text: event.detail ? `${event.name}: ${event.detail}` : event.name, rawLine };
    case 'usage':
      return {
        eventType: 'status',
        text: 'Usage',
        tokenUsage: { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, totalCost: event.usage.costUsd ?? null },
        rawLine,
      };
    case 'rate_limit':
      return { eventType: 'status', text: `Rate limited: ${event.message}`, rawLine };
    case 'error':
      return { eventType: 'raw', text: `Error: ${event.message}`, rawLine };
  }
}

function agentStatus(report: Report | undefined): AgentStatus {
  if (report?.status === 'ok') return report.finalText.trim() ? 'success' : 'error';
  if (report?.status === 'aborted') return 'cancelled';
  return 'error';
}

export async function runAgentsParallel(options: {
  agents: AgentConfig[];
  prompt: string;
  imagePaths?: string[];
  callbacks: RunnerCallbacks;
  controller?: RunController;
  drivers: ReadonlyMap<string, HeadlessCliDriver>;
}): Promise<AgentResult[]> {
  log.info(`runAgentsParallel: starting ${options.agents.length} agents`);
  log.debug(`runAgentsParallel: agents:`, options.agents.map((a) => a.name));

  const controller = options.controller ?? new RunController();
  const results = await Promise.all(options.agents.map((agent) => runSingleAgent({ ...options, agent, controller })));

  const successCount = results.filter((r) => r.status === 'success').length;
  log.info(`runAgentsParallel: completed - ${successCount}/${results.length} succeeded`);

  return results;
}

async function runSingleAgent(options: {
  agent: AgentConfig;
  prompt: string;
  imagePaths?: string[];
  callbacks: RunnerCallbacks;
  controller: RunController;
  drivers: ReadonlyMap<string, HeadlessCliDriver>;
}): Promise<AgentResult> {
  const { agent, callbacks, controller } = options;
  const agentKey = agent.instanceId ?? agent.id;
  const driver = options.drivers.get(agent.id);
  const startedAt = new Date().toISOString();

  if (!driver) {
    const error = `No provider found for agent type "${agent.id}"`;
    callbacks.onStatus?.(agentKey, 'error');
    return {
      id: agent.id,
      agentKey,
      name: agent.name,
      status: 'error',
      startedAt,
      endedAt: startedAt,
      rawOutput: [],
      normalizedPlan: `Error: ${error}`,
      errors: [error],
      command: [],
      events: [],
    };
  }

  const signal = controller.register(agentKey);
  const events: ParsedEvent[] = [];
  let report: Report | undefined;
  let thrown: string | undefined;
  callbacks.onStatus?.(agentKey, 'running');

  try {
    const brief = agentBrief(options.prompt, agent.cwd, options.imagePaths);
    const runOptions = { cwd: agent.cwd, model: agent.model || undefined, timeoutMs: AGENT_TIMEOUT_MS, signal };
    for await (const event of driver.run(brief, runOptions)) {
      if (event.type === 'done') {
        report = event.report;
        continue;
      }
      const parsed = toParsedEvent(event);
      events.push(parsed);
      callbacks.onEvent?.(agentKey, parsed);
    }
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
    log.error(`runSingleAgent: ${agent.name} failed:`, thrown);
  } finally {
    controller.unregister(agentKey);
  }

  const status = controller.isCancelled ? 'cancelled' : agentStatus(report);
  callbacks.onStatus?.(agentKey, status);

  const errors = thrown ? [thrown] : (report?.errors ?? []);
  if (status === 'error' && errors.length === 0) errors.push(`${agent.name} returned no plan`);

  return {
    id: agent.id,
    agentKey,
    name: agent.name,
    status,
    startedAt,
    endedAt: new Date().toISOString(),
    rawOutput: [],
    normalizedPlan: status === 'success' ? (report?.finalText.trim() ?? '') : `Error: ${errors.join('; ') || status}`,
    errors,
    command: [driver.id],
    events,
  };
}

export interface AgentModelInfo {
  id: string;
  models: string[];
  defaultModel: string;
  supportsDiscovery: boolean;
}
