import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
  type Part,
  type ReasoningPart,
  type StepFinishPart,
  type TextPart,
  type ToolPart,
} from '@opencode-ai/sdk';
import { promises as fs } from 'node:fs';
import type { AgentProvider, AgentExecutionConfig } from '../ports/agent-provider.js';
import type { AgentResult } from '../domain/agent/agent-result.js';
import type { ParsedEvent, TokenUsage } from '../domain/agent/parsed-event.js';
import type { RunnerCallbacks } from '../ports/agent-provider.js';
import { wrapPromptForResearch } from '../domain/deliberation/prompts.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('opencode-provider');

const READONLY_TOOLS: Record<string, boolean> = {
  read: true,
  glob: true,
  grep: true,
  list: true,
  webfetch: true,
  websearch: true,
  todoread: true,
  skill: true,
  write: false,
  edit: false,
  bash: false,
  task: false,
  todowrite: false,
  notebook_edit: false,
};

export interface OpenCodeServerHandle {
  url: string;
  close: () => void;
}

export interface OpenCodeSdkConfig {
  serverUrl?: string;
  embedded?: boolean;
  hostname?: string;
  port?: number;
}

let embeddedServer: OpenCodeServerHandle | null = null;
let initPromise: Promise<{
  client: OpencodeClient;
  serverHandle: OpenCodeServerHandle | null;
}> | null = null;
let externalUrl: string | null = null;

export async function ensureOpenCodeServer(
  config: OpenCodeSdkConfig,
): Promise<{
  client: OpencodeClient;
  serverHandle: OpenCodeServerHandle | null;
}> {
  if (config.serverUrl) {
    externalUrl = config.serverUrl;
    log.info(`Connecting to external OpenCode server at ${config.serverUrl}`);
    const client = createOpencodeClient({ baseUrl: config.serverUrl });
    return { client, serverHandle: null };
  }

  if (externalUrl) {
    const client = createOpencodeClient({ baseUrl: externalUrl });
    return { client, serverHandle: null };
  }

  if (!initPromise) {
    initPromise = (async () => {
      log.info('Starting embedded OpenCode server');
      const server = await createOpencodeServer({
        hostname: config.hostname ?? '127.0.0.1',
        port: config.port ?? 0,
      });
      embeddedServer = server;
      log.info(`Embedded OpenCode server started at ${server.url}`);
      const client = createOpencodeClient({ baseUrl: server.url });
      return { client, serverHandle: server };
    })();
  }

  return initPromise;
}

export function shutdownEmbeddedServer() {
  if (embeddedServer) {
    log.info('Shutting down embedded OpenCode server');
    embeddedServer.close();
    embeddedServer = null;
  }
  initPromise = null;
  externalUrl = null;
}

function truncateLabel(text: string, maxLen: number): string {
  const oneLine = text.split('\n').join(' ').trim();
  if (oneLine.length > maxLen) return oneLine.slice(0, maxLen - 3) + '...';
  return oneLine;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseModelSpec(model?: string | null): { providerID: string; modelID: string } | null {
  if (!model?.trim()) return null;
  const parts = model.split('/');
  if (parts.length >= 2) {
    return { providerID: parts[0], modelID: parts.slice(1).join('/') };
  }
  return null;
}

function parsePartToEvent(part: Part, delta?: string): ParsedEvent[] {
  const rawLine = JSON.stringify(part);

  switch (part.type) {
    case 'text': {
      const text = delta ?? (part as TextPart).text;
      if (!text) return [];
      return [{ eventType: 'text', text, rawLine }];
    }
    case 'reasoning': {
      const text = delta ?? (part as ReasoningPart).text;
      return [{ eventType: 'thinking', text: text || 'Reasoning...', rawLine }];
    }
    case 'tool': {
      const toolPart = part as ToolPart;
      const toolName = toolPart.tool;
      const state = toolPart.state;
      let label = toolName ? `Tool: ${toolName}` : 'Tool use';

      if (state.status === 'running' && 'title' in state && state.title) {
        label = truncateLabel(state.title, 80);
      } else if (state.status === 'completed' && 'title' in state && state.title) {
        label = truncateLabel(state.title, 80);
      }

      if ('input' in state && state.input) {
        const command = asString(state.input.command);
        const filePath = asString(state.input.file_path) || asString(state.input.path);
        const pattern = asString(state.input.pattern);
        if (command) label += ` -> ${truncateLabel(command, 70)}`;
        else if (filePath) label += ` -> ${truncateLabel(filePath, 70)}`;
        else if (pattern) label += ` -> ${truncateLabel(pattern, 70)}`;
      }

      if (state.status !== 'running' && state.status !== 'pending') {
        label += ` (${state.status})`;
      }

      return [{ eventType: 'tool_call', text: label, rawLine }];
    }
    case 'step-start':
      return [{ eventType: 'status', text: 'Step started', rawLine }];
    case 'step-finish': {
      const stepPart = part as StepFinishPart;
      const tokenUsage: TokenUsage = {
        inputTokens: stepPart.tokens.input,
        outputTokens: stepPart.tokens.output + stepPart.tokens.reasoning,
        totalCost: stepPart.cost > 0 ? stepPart.cost : null,
      };
      const reason = stepPart.reason;
      const statusText = reason ? `Step completed (${reason})` : 'Step completed';
      return [{ eventType: 'status', text: statusText, rawLine, tokenUsage }];
    }
    default:
      return [];
  }
}

async function streamSessionEvents(options: {
  client: OpencodeClient;
  sessionId: string;
  agentKey: string;
  callbacks: RunnerCallbacks;
  events: ParsedEvent[];
  planFragments: string[];
  rawOutput: string[];
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { client, sessionId, agentKey, callbacks, events, planFragments, rawOutput } = options;

  const { stream } = await client.event.subscribe();

  const abortPromise = new Promise<{ done: true; value: undefined }>((resolve) => {
    if (options.abortSignal?.aborted) {
      resolve({ done: true, value: undefined });
      return;
    }
    options.abortSignal?.addEventListener(
      'abort',
      () => resolve({ done: true, value: undefined }),
      { once: true },
    );
  });

  let inactivityTimer: ReturnType<typeof setTimeout>;
  let inactivityResolve: ((v: { done: true; value: undefined }) => void) | null = null;
  const resetInactivityTimeout = () => {
    clearTimeout(inactivityTimer);
    if (inactivityResolve) inactivityResolve = null;
    return new Promise<{ done: true; value: undefined }>((resolve) => {
      inactivityResolve = resolve;
      inactivityTimer = setTimeout(() => {
        log.warn(`streamSessionEvents: inactivity timeout (120s) for ${agentKey}`);
        resolve({ done: true, value: undefined });
      }, 120_000);
    });
  };
  let inactivityPromise = resetInactivityTimeout();

  const assistantMessageIds = new Set<string>();
  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    const result = await Promise.race([iterator.next(), abortPromise, inactivityPromise]);

    if (result.done || options.abortSignal?.aborted) {
      if (options.abortSignal?.aborted) {
        log.info(`streamSessionEvents: aborted for ${agentKey}`);
      }
      break;
    }

    const event = result.value;
    const typedEvent = event as Record<string, unknown>;
    const eventType = typedEvent.type as string;
    const properties = typedEvent.properties as Record<string, unknown> | undefined;

    if (eventType === 'message.part.updated' && properties) {
      const part = properties.part as Part;
      const delta = properties.delta as string | undefined;

      if ('sessionID' in part && part.sessionID !== sessionId) continue;

      const partRecord = part as unknown as Record<string, unknown>;
      const messageID = typeof partRecord.messageID === 'string' ? partRecord.messageID : undefined;

      if (messageID && part.type !== 'text') {
        assistantMessageIds.add(messageID);
      }

      if (part.type === 'text' && messageID && !assistantMessageIds.has(messageID)) {
        continue;
      }

      const parsed = parsePartToEvent(part, delta);
      for (const p of parsed) {
        events.push(p);
        rawOutput.push(JSON.stringify(typedEvent));
        callbacks.onEvent?.(agentKey, p);
        if (p.eventType === 'text') {
          const textToAdd = delta ?? p.text;
          if (planFragments.length > 0) {
            planFragments[planFragments.length - 1] += textToAdd;
          } else {
            planFragments.push(textToAdd);
          }
        }
      }
      inactivityPromise = resetInactivityTimeout();
    } else if (eventType === 'session.idle' && properties) {
      const idleSessionId = properties.sessionID as string;
      if (idleSessionId === sessionId) {
        log.info(`streamSessionEvents: session ${sessionId} is idle, done`);
        break;
      }
      inactivityPromise = resetInactivityTimeout();
    } else if (eventType === 'session.status' && properties) {
      const statusSessionId = properties.sessionID as string;
      if (statusSessionId !== sessionId) continue;

      const status = properties.status as { type: string; message?: string };
      if (status.type === 'retry') {
        const retryEvent: ParsedEvent = {
          eventType: 'status',
          text: `Retrying: ${status.message ?? 'unknown error'}`,
          rawLine: JSON.stringify(typedEvent),
        };
        events.push(retryEvent);
        callbacks.onEvent?.(agentKey, retryEvent);
      }
      inactivityPromise = resetInactivityTimeout();
    }
  }

  clearTimeout(inactivityTimer!);
}

export class OpenCodeProvider implements AgentProvider {
  readonly id = 'opencode';
  readonly name = 'OpenCode';

  async discoverModels(): Promise<string[]> {
    try {
      const { client } = await ensureOpenCodeServer({});
      const providersRes = await client.config.providers();
      const providersData = providersRes.data;

      const models: string[] = [];
      if (providersData && typeof providersData === 'object' && 'providers' in providersData) {
        const providers = (
          providersData as { providers?: Array<{ id: string; models?: Record<string, unknown> }> }
        ).providers;
        if (Array.isArray(providers)) {
          for (const provider of providers) {
            const providerId = provider.id;
            if (provider.models && typeof provider.models === 'object') {
              for (const modelId of Object.keys(provider.models)) {
                models.push(`${providerId}/${modelId}`);
              }
            }
          }
        }
      }

      log.info(`discoverModels: found ${models.length} models`);
      return models.sort();
    } catch (err) {
      log.warn('discoverModels: failed:', err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async execute(config: AgentExecutionConfig): Promise<AgentResult> {
    const { agent, prompt, callbacks } = config;
    const agentKey = agent.instanceId ?? agent.id;
    const startedAt = new Date().toISOString();
    const events: ParsedEvent[] = [];
    const planFragments: string[] = [];
    const errors: string[] = [];
    const rawOutput: string[] = [];

    callbacks.onStatus?.(agentKey, 'running');
    log.info(`execute: starting ${agent.name} (${agentKey})`);

    try {
      const { client } = await ensureOpenCodeServer({});

      const sessionRes = await client.session.create({
        body: { title: `Concilium: ${agent.name}` },
      });
      const session = sessionRes.data;
      if (!session) throw new Error('Failed to create OpenCode session');
      const sessionId = session.id;
      log.info(`execute: created session ${sessionId} for ${agent.name}`);

      const modelSpec = parseModelSpec(agent.model);

      let toolsMap: Record<string, boolean> = { ...READONLY_TOOLS };
      try {
        const toolIdsRes = await client.tool.ids();
        const allToolIds = toolIdsRes.data;
        if (Array.isArray(allToolIds)) {
          const fullMap: Record<string, boolean> = {};
          for (const toolId of allToolIds) {
            fullMap[toolId] = READONLY_TOOLS[toolId] ?? false;
          }
          toolsMap = fullMap;
        }
      } catch {
        log.warn('execute: could not discover tool IDs, using static allowlist');
      }

      const eventPromise = streamSessionEvents({
        client,
        sessionId,
        agentKey,
        callbacks,
        events,
        planFragments,
        rawOutput,
        abortSignal: config.abortSignal,
      });

      const wrappedPrompt = wrapPromptForResearch(prompt);
      const textPart = { type: 'text' as const, text: wrappedPrompt };
      const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mimeType: string }> = [textPart];

      if (config.images && config.images.length > 0) {
        log.info(`execute: processing ${config.images.length} image(s)`);
        for (const img of config.images) {
          try {
            let imageData: string | undefined;
            if (img.base64) {
              imageData = img.base64;
            } else if (img.path) {
              imageData = await fs.readFile(img.path, { encoding: 'base64' });
            }
            if (imageData) {
              parts.push({ type: 'image' as const, image: imageData, mimeType: img.mimeType });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error(`execute: failed to process image: ${message}`);
            errors.push(`Failed to process image: ${message}`);
          }
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: parts as any,
          tools: toolsMap,
          system: 'You are a research advisor in a multi-agent council. Your ONLY job is to propose a plan — NEVER implement it. Return your plan as markdown text in your response. NEVER write, edit, create, or delete files. NEVER use write/edit/bash tools. You may only use read-only tools (read, glob, grep, web search). Never ask the user questions or request clarification. You are running autonomously. Make your best judgment and state any assumptions.',
          ...(modelSpec ? { model: modelSpec } : {}),
        },
      });

      await eventPromise;

      const messagesRes = await client.session.messages({ path: { id: sessionId } });
      const messages = messagesRes.data;
      let finalTokenUsage: TokenUsage | null = null;

      if (Array.isArray(messages)) {
        const assistantEntry = messages.find((m) => m.info.role === 'assistant');
        if (assistantEntry) {
          const assistantInfo = assistantEntry.info as {
            role: 'assistant';
            tokens: { input: number; output: number; reasoning: number };
            cost: number;
          };
          finalTokenUsage = {
            inputTokens: assistantInfo.tokens.input,
            outputTokens: assistantInfo.tokens.output + assistantInfo.tokens.reasoning,
            totalCost: assistantInfo.cost > 0 ? assistantInfo.cost : null,
          };
        }
      }

      if (finalTokenUsage) {
        const usageEvent: ParsedEvent = {
          eventType: 'status',
          text: 'Completed',
          rawLine: '',
          tokenUsage: finalTokenUsage,
          tokenUsageCumulative: true,
        };
        events.push(usageEvent);
        callbacks.onEvent?.(agentKey, usageEvent);
      }

      const normalizedPlan = planFragments.join('').trim() || 'No plan could be extracted.';
      callbacks.onStatus?.(agentKey, 'success');
      log.info(`execute: ${agent.name} completed successfully (${normalizedPlan.length} chars)`);

      return {
        id: agent.id,
        agentKey,
        name: agent.name,
        status: 'success',
        startedAt,
        endedAt: new Date().toISOString(),
        rawOutput: [],
        normalizedPlan,
        errors,
        command: ['opencode-sdk', agent.model ?? ''],
        events,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`execute: ${agent.name} failed:`, message);
      errors.push(message);
      callbacks.onStatus?.(agentKey, 'error');

      return {
        id: agent.id,
        agentKey,
        name: agent.name,
        status: 'error',
        startedAt,
        endedAt: new Date().toISOString(),
        rawOutput: [],
        normalizedPlan: `Error: ${message}`,
        errors,
        command: ['opencode-sdk', agent.model ?? ''],
        events,
      };
    }
  }
}
