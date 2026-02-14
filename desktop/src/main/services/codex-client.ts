/**
 * Codex SDK client for Concilium.
 *
 * Uses @openai/codex-sdk to run Codex agents in read-only sandbox mode
 * instead of spawning the CLI as a subprocess.  Plans are streamed as
 * events and returned as markdown text.
 */

/* eslint-disable import/no-unresolved */
import {
  Codex,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
  type ThreadOptions,
} from '@openai/codex-sdk';
/* eslint-enable import/no-unresolved */
import type { AgentConfig, AgentResult, ParsedEvent, TokenUsage } from './types';
import type { RunnerCallbacks } from './runner';
import { wrapPromptForResearch } from './commands';
import { createLogger } from './logger';

const log = createLogger('codex-client');

// ── Types ─────────────────────────────────────────────────────────────

export interface CodexSdkConfig {
  /** Override the codex binary path (optional) */
  codexPath?: string;
  /** Override the API base URL (optional) */
  baseUrl?: string;
  /** Override the API key (optional, defaults to env) */
  apiKey?: string;
}

// ── Run a single Codex agent via SDK ──────────────────────────────────

export async function runCodexSdk(options: {
  agent: AgentConfig;
  prompt: string;
  callbacks: RunnerCallbacks;
  sdkConfig: CodexSdkConfig;
  abortSignal?: AbortSignal;
}): Promise<AgentResult> {
  const { agent, prompt, callbacks, sdkConfig } = options;
  const agentKey = agent.instanceId ?? agent.id;
  const startedAt = new Date().toISOString();
  const events: ParsedEvent[] = [];
  const planFragments: string[] = [];
  const errors: string[] = [];
  const rawOutput: string[] = [];

  callbacks.onStatus?.(agentKey, 'running');
  log.info(`runCodexSdk: starting ${agent.name} (${agentKey})`);

  try {
    // 1. Create Codex instance
    const codex = new Codex({
      ...(sdkConfig.codexPath ? { codexPathOverride: sdkConfig.codexPath } : {}),
      ...(sdkConfig.baseUrl ? { baseUrl: sdkConfig.baseUrl } : {}),
      ...(sdkConfig.apiKey ? { apiKey: sdkConfig.apiKey } : {}),
    });

    // 2. Start a thread in read-only sandbox mode
    const threadOptions: ThreadOptions = {
      sandboxMode: 'read-only',
      workingDirectory: agent.cwd,
      skipGitRepoCheck: true,
      webSearchEnabled: true,
      approvalPolicy: 'never',
    };

    if (agent.model?.trim()) {
      threadOptions.model = agent.model.trim();
    }

    const thread = codex.startThread(threadOptions);
    log.info(`runCodexSdk: thread started for ${agent.name} (read-only sandbox)`);

    // 3. Run with streaming
    const wrappedPrompt = wrapPromptForResearch(prompt);
    const { events: eventStream } = await thread.runStreamed(wrappedPrompt, {
      signal: options.abortSignal,
    });

    // 4. Process streamed events
    let totalUsage: Usage | null = null;

    for await (const event of eventStream) {
      if (options.abortSignal?.aborted) {
        log.info(`runCodexSdk: aborted for ${agentKey}`);
        break;
      }

      const rawLine = JSON.stringify(event);
      rawOutput.push(rawLine);

      const parsed = mapCodexEvent(event);
      for (const p of parsed) {
        events.push(p);
        callbacks.onEvent?.(agentKey, p);
        if (p.eventType === 'text') {
          planFragments.push(p.text);
        }
      }

      if (event.type === 'turn.completed') {
        totalUsage = event.usage;
      }
    }

    // 5. Emit final usage
    if (totalUsage) {
      const usageEvent: ParsedEvent = {
        eventType: 'status',
        text: 'Completed',
        rawLine: '',
        tokenUsage: {
          inputTokens: totalUsage.input_tokens,
          outputTokens: totalUsage.output_tokens,
          totalCost: null,
        },
        tokenUsageCumulative: true,
      };
      events.push(usageEvent);
      callbacks.onEvent?.(agentKey, usageEvent);
    }

    const normalizedPlan = planFragments.join('').trim() || 'No plan could be extracted.';
    callbacks.onStatus?.(agentKey, 'success');
    log.info(`runCodexSdk: ${agent.name} completed successfully (${normalizedPlan.length} chars)`);

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
      command: ['codex-sdk', agent.model ?? ''],
      events,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`runCodexSdk: ${agent.name} failed:`, message);
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
      command: ['codex-sdk', agent.model ?? ''],
      events,
    };
  }
}

// ── Event mapping ─────────────────────────────────────────────────────

function mapCodexEvent(event: ThreadEvent): ParsedEvent[] {
  const rawLine = JSON.stringify(event);

  switch (event.type) {
    case 'thread.started':
      return [];

    case 'turn.started':
      return [{ eventType: 'status', text: 'Turn started', rawLine }];

    case 'turn.completed': {
      const usage = event.usage;
      const tokenUsage: TokenUsage = {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalCost: null,
      };
      const parsed: ParsedEvent = {
        eventType: 'status',
        text: 'Turn completed',
        rawLine,
        tokenUsage,
        tokenUsageCumulative: true,
      };
      return [parsed];
    }

    case 'turn.failed':
      return [{ eventType: 'raw', text: `Failed: ${event.error.message}`, rawLine }];

    case 'error':
      return [{ eventType: 'raw', text: `Error: ${event.message}`, rawLine }];

    case 'item.started':
      return mapItemEvent(event.item, 'started', rawLine);

    case 'item.updated':
      return mapItemEvent(event.item, 'updated', rawLine);

    case 'item.completed':
      return mapItemEvent(event.item, 'completed', rawLine);
  }

  return [];
}

function mapItemEvent(item: ThreadItem, phase: string, rawLine: string): ParsedEvent[] {
  switch (item.type) {
    case 'agent_message': {
      if (phase === 'completed') {
        return [{ eventType: 'text', text: item.text, rawLine }];
      }
      return [{ eventType: 'status', text: 'Generating response...', rawLine }];
    }

    case 'reasoning': {
      return [{ eventType: 'thinking', text: item.text || 'Reasoning...', rawLine }];
    }

    case 'command_execution': {
      const cmd = item.command ? truncateLabel(item.command, 80) : 'command';
      if (phase === 'started') {
        return [{ eventType: 'tool_call', text: `Running: ${cmd}`, rawLine }];
      }
      let label = `Ran: ${cmd}`;
      if (phase === 'completed' && item.exit_code != null) {
        label += item.exit_code === 0 ? ' \u2713' : ` (exit ${item.exit_code})`;
      }
      return [{ eventType: 'tool_call', text: label, rawLine }];
    }

    case 'web_search':
      return [{ eventType: 'tool_call', text: `Web search: ${truncateLabel(item.query, 70)}`, rawLine }];

    case 'mcp_tool_call': {
      const label = `Tool: ${item.tool}` + (item.server ? ` (${item.server})` : '');
      if (phase === 'completed' && item.status !== 'completed') {
        return [{ eventType: 'tool_call', text: `${label} (${item.status})`, rawLine }];
      }
      return [{ eventType: 'tool_call', text: label, rawLine }];
    }

    case 'file_change':
      return [{ eventType: 'tool_call', text: `File changes: ${item.changes.length} file(s) (${item.status})`, rawLine }];

    case 'todo_list':
      return [{ eventType: 'status', text: `Plan: ${item.items.length} items`, rawLine }];

    case 'error':
      return [{ eventType: 'raw', text: `Error: ${item.message}`, rawLine }];
  }

  return [];
}

// ── Helpers ───────────────────────────────────────────────────────────

function truncateLabel(text: string, maxLen: number): string {
  const oneLine = text.split('\n').join(' ').trim();
  if (oneLine.length > maxLen) return oneLine.slice(0, maxLen - 3) + '...';
  return oneLine;
}
