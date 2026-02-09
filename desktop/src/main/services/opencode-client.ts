/**
 * OpenCode SDK client for Concilium.
 *
 * Connects to an OpenCode server (either embedded or external) and runs
 * read-only research sessions.  Plans are streamed as events and returned
 * as markdown text — nothing is written to disk by the agent.
 */

/* eslint-disable import/no-unresolved */
import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
  type Part,
  type ReasoningPart,
  type StepFinishPart,
  type TextPart,
  type ToolPart,
} from "@opencode-ai/sdk";
/* eslint-enable import/no-unresolved */
import { wrapPromptForResearch } from "./commands";
import { createLogger } from "./logger";
import type { RunnerCallbacks } from "./runner";
import type {
  AgentConfig,
  AgentResult,
  ParsedEvent,
  TokenUsage,
} from "./types";

const log = createLogger("opencode-client");

// ── Read-only tool allowlist ──────────────────────────────────────────
// These are the only tools we enable when prompting via the SDK.
// Everything else (write, edit, bash, task, todowrite, etc.) is disabled.
const READONLY_TOOLS: Record<string, boolean> = {
  read: true,
  glob: true,
  grep: true,
  list: true,
  webfetch: true,
  websearch: true,
  todoread: true,
  skill: true,
  // Explicitly deny mutating tools
  write: false,
  edit: false,
  bash: false,
  task: false,
  todowrite: false,
  notebook_edit: false,
};

// ── Types ─────────────────────────────────────────────────────────────

export interface OpenCodeServerHandle {
  url: string;
  close: () => void;
}

export interface OpenCodeSdkConfig {
  /** Base URL of a running OpenCode server (e.g. "http://localhost:4096") */
  serverUrl?: string;
  /** If true, start an embedded server instead of connecting externally */
  embedded?: boolean;
  /** Hostname for embedded server */
  hostname?: string;
  /** Port for embedded server */
  port?: number;
}

// ── Server lifecycle ──────────────────────────────────────────────────

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
  // External server — no lifecycle management needed
  if (config.serverUrl) {
    externalUrl = config.serverUrl;
    log.info(`Connecting to external OpenCode server at ${config.serverUrl}`);
    const client = createOpencodeClient({ baseUrl: config.serverUrl });
    return { client, serverHandle: null };
  }

  // If a previous call connected to an external URL, reuse it
  if (externalUrl) {
    const client = createOpencodeClient({ baseUrl: externalUrl });
    return { client, serverHandle: null };
  }

  // Embedded server — deduplicate concurrent init calls with a shared promise
  if (!initPromise) {
    initPromise = (async () => {
      log.info("Starting embedded OpenCode server");
      const server = await createOpencodeServer({
        hostname: config.hostname ?? "127.0.0.1",
        port: config.port ?? 0, // 0 = random port
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
    log.info("Shutting down embedded OpenCode server");
    embeddedServer.close();
    embeddedServer = null;
  }
  initPromise = null;
  externalUrl = null;
}

// ── Run a single agent via SDK ────────────────────────────────────────

export async function runOpenCodeSdk(options: {
  agent: AgentConfig;
  prompt: string;
  callbacks: RunnerCallbacks;
  sdkConfig: OpenCodeSdkConfig;
  abortSignal?: AbortSignal;
}): Promise<AgentResult> {
  const { agent, prompt, callbacks, sdkConfig } = options;
  const agentKey = agent.instanceId ?? agent.id;
  const startedAt = new Date().toISOString();
  const events: ParsedEvent[] = [];
  const planFragments: string[] = [];
  const errors: string[] = [];
  const rawOutput: string[] = [];

  callbacks.onStatus?.(agentKey, "running");
  log.info(`runOpenCodeSdk: starting ${agent.name} (${agentKey})`);

  try {
    const { client } = await ensureOpenCodeServer(sdkConfig);

    // 1. Create a session
    const sessionRes = await client.session.create({
      body: { title: `Concilium: ${agent.name}` },
    });
    const session = sessionRes.data;
    if (!session) {
      throw new Error("Failed to create OpenCode session");
    }
    const sessionId = session.id;
    log.info(`runOpenCodeSdk: created session ${sessionId} for ${agent.name}`);

    // 2. Parse model into providerID/modelID
    const modelSpec = parseModelSpec(agent.model);

    // 3. Build the tools map — only read-only tools allowed
    // Discover all available tool IDs from server, then apply our allowlist
    let toolsMap: Record<string, boolean> = { ...READONLY_TOOLS };
    try {
      const toolIdsRes = await client.tool.ids();
      const allToolIds = toolIdsRes.data;
      if (Array.isArray(allToolIds)) {
        // Start by disabling everything, then enable only allowed ones
        const fullMap: Record<string, boolean> = {};
        for (const toolId of allToolIds) {
          fullMap[toolId] = READONLY_TOOLS[toolId] ?? false;
        }
        toolsMap = fullMap;
      }
    } catch (err) {
      log.warn(
        "runOpenCodeSdk: could not discover tool IDs, using static allowlist",
      );
    }

    log.debug("runOpenCodeSdk: tools config:", toolsMap);

    // 4. Subscribe to events BEFORE sending the prompt
    const eventPromise = streamSessionEvents({
      client,
      sessionId,
      agentKey,
      callbacks,
      events,
      planFragments,
      rawOutput,
      abortSignal: options.abortSignal,
    });

    // 5. Send the prompt (async variant — returns immediately, events stream separately)
    const wrappedPrompt = wrapPromptForResearch(prompt);
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: wrappedPrompt }],
        tools: toolsMap,
        system:
          "You are a research advisor in a multi-agent council. Your ONLY job is to propose a plan — NEVER implement it. Return your plan as markdown text in your response. NEVER write, edit, create, or delete files. NEVER use write/edit/bash tools. You may only use read-only tools (read, glob, grep, web search).",
        ...(modelSpec ? { model: modelSpec } : {}),
      },
    });

    log.info(
      `runOpenCodeSdk: prompt sent for ${agent.name}, streaming events...`,
    );

    // 6. Wait for session to complete (session.idle event)
    await eventPromise;

    // 7. Fetch the assistant message to get final text and token usage
    const messagesRes = await client.session.messages({
      path: { id: sessionId },
    });
    const messages = messagesRes.data;
    let finalTokenUsage: TokenUsage | null = null;

    if (Array.isArray(messages)) {
      const assistantEntry = messages.find((m) => m.info.role === "assistant");
      if (assistantEntry) {
        const assistantInfo = assistantEntry.info as {
          role: "assistant";
          tokens: { input: number; output: number; reasoning: number };
          cost: number;
        };
        finalTokenUsage = {
          inputTokens: assistantInfo.tokens.input,
          outputTokens:
            assistantInfo.tokens.output + assistantInfo.tokens.reasoning,
          totalCost: assistantInfo.cost > 0 ? assistantInfo.cost : null,
        };
      }
    }

    if (finalTokenUsage) {
      const usageEvent: ParsedEvent = {
        eventType: "status",
        text: "Completed",
        rawLine: "",
        tokenUsage: finalTokenUsage,
        tokenUsageCumulative: true,
      };
      events.push(usageEvent);
      callbacks.onEvent?.(agentKey, usageEvent);
    }

    const normalizedPlan =
      planFragments.join("").trim() || "No plan could be extracted.";
    callbacks.onStatus?.(agentKey, "success");
    log.info(
      `runOpenCodeSdk: ${agent.name} completed successfully (${normalizedPlan.length} chars)`,
    );

    return {
      id: agent.id,
      agentKey,
      name: agent.name,
      status: "success",
      startedAt,
      endedAt: new Date().toISOString(),
      rawOutput,
      normalizedPlan,
      errors,
      command: ["opencode-sdk", agent.model ?? ""],
      events,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`runOpenCodeSdk: ${agent.name} failed:`, message);
    errors.push(message);
    callbacks.onStatus?.(agentKey, "error");

    return {
      id: agent.id,
      agentKey,
      name: agent.name,
      status: "error",
      startedAt,
      endedAt: new Date().toISOString(),
      rawOutput,
      normalizedPlan: `Error: ${message}`,
      errors,
      command: ["opencode-sdk", agent.model ?? ""],
      events,
    };
  }
}

// ── Event streaming ───────────────────────────────────────────────────

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
  const {
    client,
    sessionId,
    agentKey,
    callbacks,
    events,
    planFragments,
    rawOutput,
  } = options;

  const { stream } = await client.event.subscribe();

  for await (const event of stream) {
    // Check abort
    if (options.abortSignal?.aborted) {
      log.info(`streamSessionEvents: aborted for ${agentKey}`);
      break;
    }

    const typedEvent = event as Record<string, unknown>;
    const eventType = typedEvent.type as string;

    // Only process events for our session
    const properties = typedEvent.properties as
      | Record<string, unknown>
      | undefined;

    if (eventType === "message.part.updated" && properties) {
      const part = properties.part as Part;
      const delta = properties.delta as string | undefined;

      // Only process parts for our session
      if ("sessionID" in part && part.sessionID !== sessionId) continue;

      const parsed = parsePartToEvent(part, delta);
      if (parsed.length > 0) {
        for (const p of parsed) {
          events.push(p);
          rawOutput.push(JSON.stringify(typedEvent));
          callbacks.onEvent?.(agentKey, p);
          if (p.eventType === "text") {
            // Concatenate delta to the last fragment to handle word-by-word streaming
            const textToAdd = delta ?? p.text;
            if (planFragments.length > 0) {
              planFragments[planFragments.length - 1] += textToAdd;
            } else {
              planFragments.push(textToAdd);
            }
          }
        }
      }
    } else if (eventType === "session.idle" && properties) {
      const idleSessionId = properties.sessionID as string;
      if (idleSessionId === sessionId) {
        log.info(`streamSessionEvents: session ${sessionId} is idle, done`);
        break;
      }
    } else if (eventType === "session.status" && properties) {
      const statusSessionId = properties.sessionID as string;
      if (statusSessionId !== sessionId) continue;

      const status = properties.status as { type: string; message?: string };
      if (status.type === "retry") {
        const retryEvent: ParsedEvent = {
          eventType: "status",
          text: `Retrying: ${status.message ?? "unknown error"}`,
          rawLine: JSON.stringify(typedEvent),
        };
        events.push(retryEvent);
        callbacks.onEvent?.(agentKey, retryEvent);
      }
    }
  }
}

// ── Part → ParsedEvent mapping ────────────────────────────────────────

function parsePartToEvent(part: Part, delta?: string): ParsedEvent[] {
  const rawLine = JSON.stringify(part);

  switch (part.type) {
    case "text": {
      const text = delta ?? (part as TextPart).text;
      if (!text) return [];
      return [{ eventType: "text", text, rawLine }];
    }

    case "reasoning": {
      const text = delta ?? (part as ReasoningPart).text;
      return [{ eventType: "thinking", text: text || "Reasoning...", rawLine }];
    }

    case "tool": {
      const toolPart = part as ToolPart;
      const toolName = toolPart.tool;
      const state = toolPart.state;
      let label = toolName ? `Tool: ${toolName}` : "Tool use";

      if (state.status === "running" && "title" in state && state.title) {
        label = truncateLabel(state.title, 80);
      } else if (
        state.status === "completed" &&
        "title" in state &&
        state.title
      ) {
        label = truncateLabel(state.title, 80);
      }

      // Append key input fields for context
      if ("input" in state && state.input) {
        const command = asString(state.input.command);
        const filePath =
          asString(state.input.file_path) || asString(state.input.path);
        const pattern = asString(state.input.pattern);
        if (command) label += ` -> ${truncateLabel(command, 70)}`;
        else if (filePath) label += ` -> ${truncateLabel(filePath, 70)}`;
        else if (pattern) label += ` -> ${truncateLabel(pattern, 70)}`;
      }

      if (state.status !== "running" && state.status !== "pending") {
        label += ` (${state.status})`;
      }

      return [{ eventType: "tool_call", text: label, rawLine }];
    }

    case "step-start":
      return [{ eventType: "status", text: "Step started", rawLine }];

    case "step-finish": {
      const stepPart = part as StepFinishPart;
      const tokenUsage: TokenUsage = {
        inputTokens: stepPart.tokens.input,
        outputTokens: stepPart.tokens.output + stepPart.tokens.reasoning,
        totalCost: stepPart.cost > 0 ? stepPart.cost : null,
      };
      const reason = stepPart.reason;
      const statusText = reason
        ? `Step completed (${reason})`
        : "Step completed";
      return [{ eventType: "status", text: statusText, rawLine, tokenUsage }];
    }

    default:
      return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseModelSpec(
  model?: string | null,
): { providerID: string; modelID: string } | null {
  if (!model?.trim()) return null;

  // Model format: "providerID/modelID" or "providerID/sub/modelID"
  // e.g., "openrouter/anthropic/claude-sonnet-4" → provider="openrouter", model="anthropic/claude-sonnet-4"
  const parts = model.split("/");
  if (parts.length >= 2) {
    return {
      providerID: parts[0],
      modelID: parts.slice(1).join("/"),
    };
  }

  return null;
}

function truncateLabel(text: string, maxLen: number): string {
  const oneLine = text.split("\n").join(" ").trim();
  if (oneLine.length > maxLen) return oneLine.slice(0, maxLen - 3) + "...";
  return oneLine;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
