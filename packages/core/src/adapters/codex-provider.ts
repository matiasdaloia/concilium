import {
  Codex,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
  type ThreadOptions,
} from '@openai/codex-sdk';
import type { AgentProvider, AgentExecutionConfig } from '../ports/agent-provider.js';
import type { AgentResult } from '../domain/agent/agent-result.js';
import type { ParsedEvent, TokenUsage } from '../domain/agent/parsed-event.js';
import { wrapPromptForResearch } from '../domain/deliberation/prompts.js';
import { createLogger } from '../shared/logger.js';
import { CODEX_MODELS, DEFAULT_AGENT_MODELS } from '../domain/agent/agent-executor.js';

const log = createLogger('codex-provider');

function truncateLabel(text: string, maxLen: number): string {
  const oneLine = text.split('\n').join(' ').trim();
  if (oneLine.length > maxLen) return oneLine.slice(0, maxLen - 3) + '...';
  return oneLine;
}

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
      return [{ eventType: 'status', text: 'Turn completed', rawLine, tokenUsage, tokenUsageCumulative: true }];
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
      if (phase === 'completed') return [{ eventType: 'text', text: item.text, rawLine }];
      return [{ eventType: 'status', text: 'Generating response...', rawLine }];
    }
    case 'reasoning':
      return [{ eventType: 'thinking', text: item.text || 'Reasoning...', rawLine }];
    case 'command_execution': {
      const cmd = item.command ? truncateLabel(item.command, 80) : 'command';
      if (phase === 'started') return [{ eventType: 'tool_call', text: `Running: ${cmd}`, rawLine }];
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

export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly name = 'Codex';

  async discoverModels(): Promise<string[]> {
    return CODEX_MODELS;
  }

  async execute(config: AgentExecutionConfig): Promise<AgentResult> {
    const { agent, prompt, callbacks } = config;
    const agentKey = agent.instanceId ?? agent.id;
    const startedAt = new Date().toISOString();
    const events: ParsedEvent[] = [];
    const planFragments: string[] = [];
    const errors: string[] = [];

    callbacks.onStatus?.(agentKey, 'running');
    log.info(`execute: starting ${agent.name} (${agentKey})`);

    try {
      const codex = new Codex({});

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
      const wrappedPrompt = wrapPromptForResearch(prompt);
      const { events: eventStream } = await thread.runStreamed(wrappedPrompt, {
        signal: config.abortSignal,
      });

      let totalUsage: Usage | null = null;

      for await (const event of eventStream) {
        if (config.abortSignal?.aborted) break;

        const parsed = mapCodexEvent(event);
        for (const p of parsed) {
          events.push(p);
          callbacks.onEvent?.(agentKey, p);
          if (p.eventType === 'text') planFragments.push(p.text);
        }

        if (event.type === 'turn.completed') {
          totalUsage = event.usage;
        }
      }

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
        command: ['codex-sdk', agent.model ?? ''],
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
        command: ['codex-sdk', agent.model ?? ''],
        events,
      };
    }
  }
}
