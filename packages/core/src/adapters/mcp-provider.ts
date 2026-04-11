import type { AgentProvider, AgentExecutionConfig } from '../ports/agent-provider.js';
import type { AgentResult } from '../domain/agent/agent-result.js';
import type { McpAgentId } from '../domain/agent/agent-config.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('mcp-provider');

export interface McpProviderConfig {
  id: string;
  name: string;
  mcpServerUrl: string;
  toolName: string;
  headers?: Record<string, string>;
}

export class McpAgentProvider implements AgentProvider {
  readonly id: string;
  readonly name: string;
  private readonly serverUrl: string;
  private readonly toolName: string;
  private readonly customHeaders: Record<string, string>;

  constructor(config: McpProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.serverUrl = config.mcpServerUrl.replace(/\/$/, '');
    this.toolName = config.toolName;
    this.customHeaders = config.headers ?? {};
  }

  async discoverModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.serverUrl}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.customHeaders },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });

      if (!response.ok) return [];

      const data = await response.json() as { result?: { tools?: Array<{ name: string }> } };
      return data.result?.tools?.map((t) => t.name) ?? [];
    } catch {
      logger.debug(`Failed to discover models from MCP server at ${this.serverUrl}`);
      return [];
    }
  }

  async execute(config: AgentExecutionConfig): Promise<AgentResult> {
    const { agent, prompt, callbacks, abortSignal } = config;
    const agentKey = agent.instanceId ?? agent.id;
    const startedAt = new Date().toISOString();
    const planFragments: string[] = [];
    const errors: string[] = [];

    callbacks.onStatus?.(agentKey, 'running');

    try {
      const controller = new AbortController();
      const signal = controller.signal;

      if (abortSignal) {
        if (abortSignal.aborted) {
          callbacks.onStatus?.(agentKey, 'cancelled');
          return this.buildResult(agent.id as McpAgentId, agentKey, agent.name, 'cancelled', startedAt, '', errors, []);
        }
        abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      const response = await fetch(`${this.serverUrl}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.customHeaders },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: this.toolName,
            arguments: { prompt, cwd: agent.cwd },
          },
        }),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        errors.push(`MCP server returned HTTP ${response.status}: ${body.slice(0, 200)}`);
        callbacks.onStatus?.(agentKey, 'error');
        return this.buildResult(agent.id as McpAgentId, agentKey, agent.name, 'error', startedAt, '', errors, []);
      }

      // Handle SSE streaming or plain JSON response
      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream')) {
        await this.handleSSEStream(response, agentKey, planFragments, callbacks, signal);
      } else {
        const data = await response.json() as {
          result?: { content?: Array<{ type: string; text?: string }> };
          error?: { message: string };
        };

        if (data.error) {
          errors.push(data.error.message);
          callbacks.onStatus?.(agentKey, 'error');
          return this.buildResult(agent.id as McpAgentId, agentKey, agent.name, 'error', startedAt, '', errors, []);
        }

        const textContent = data.result?.content
          ?.filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!)
          .join('\n') ?? '';

        planFragments.push(textContent);
        callbacks.onEvent?.(agentKey, {
          eventType: 'text',
          text: textContent,
          rawLine: textContent,
        });
      }

      const normalizedPlan = planFragments.join('');
      callbacks.onStatus?.(agentKey, 'success');

      return this.buildResult(
        agent.id as McpAgentId,
        agentKey,
        agent.name,
        'success',
        startedAt,
        normalizedPlan,
        errors,
        [],
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        callbacks.onStatus?.(agentKey, 'cancelled');
        return this.buildResult(agent.id as McpAgentId, agentKey, agent.name, 'cancelled', startedAt, planFragments.join(''), errors, []);
      }
      errors.push((err as Error).message);
      callbacks.onStatus?.(agentKey, 'error');
      return this.buildResult(agent.id as McpAgentId, agentKey, agent.name, 'error', startedAt, '', errors, []);
    }
  }

  private async handleSSEStream(
    response: Response,
    agentKey: string,
    planFragments: string[],
    callbacks: AgentExecutionConfig['callbacks'],
    signal: AbortSignal,
  ): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;

          try {
            const event = JSON.parse(data) as {
              type?: string;
              text?: string;
              content?: Array<{ type: string; text?: string }>;
            };

            const text = event.text
              ?? event.content?.find((c) => c.type === 'text')?.text
              ?? '';

            if (text) {
              planFragments.push(text);
              callbacks.onEvent?.(agentKey, {
                eventType: 'text',
                text,
                rawLine: line,
              });
            }
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private buildResult(
    id: McpAgentId,
    agentKey: string,
    name: string,
    status: AgentResult['status'],
    startedAt: string,
    normalizedPlan: string,
    errors: string[],
    command: string[],
  ): AgentResult {
    return {
      id,
      agentKey,
      name,
      status,
      startedAt,
      endedAt: new Date().toISOString(),
      normalizedPlan,
      errors,
      command,
      events: [],
    };
  }
}
