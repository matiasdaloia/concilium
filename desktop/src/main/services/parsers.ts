import type { AgentId, EventType, ParsedEvent, TokenUsage } from './types';

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function truncateLabel(text: string, maxLen: number): string {
  const oneLine = text.split('\n').join(' ').trim();
  if (oneLine.length > maxLen) return oneLine.slice(0, maxLen - 3) + '...';
  return oneLine;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractTokenUsage(obj: Record<string, unknown>): TokenUsage | null {
  const usage = asRecord(obj.usage);
  const inputTokens = Math.floor(asNumber(usage.input_tokens));
  const outputTokens = Math.floor(asNumber(usage.output_tokens));
  if (inputTokens === 0 && outputTokens === 0) return null;
  const cost = asNumber(obj.total_cost_usd || usage.total_cost);
  return { inputTokens, outputTokens, totalCost: cost > 0 ? cost : null };
}

export function parseEventLine(agentId: AgentId, line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    const cleaned = stripAnsi(trimmed);
    if (!cleaned) return null;
    // For OpenCode, check if this is a share link before falling back to raw
    if (agentId === 'opencode') {
      const shareLink = parseOpenCodeShareLink(cleaned);
      if (shareLink) return shareLink;
    }
    return { eventType: 'raw', text: cleaned, rawLine: line };
  }

  if (agentId === 'codex') return parseCodexEvent(payload, line);
  if (agentId === 'claude') return parseClaudeEvent(payload, line);
  return parseOpenCodeEvent(payload, line);
}

function ev(eventType: EventType, text: string, rawLine: string, tokenUsage?: TokenUsage | null): ParsedEvent {
  return { eventType, text, rawLine, tokenUsage };
}

function parseCodexEvent(payload: unknown, rawLine: string): ParsedEvent | null {
  const event = asRecord(payload);
  const eventType = asString(event.type);

  if (['thread.started', 'turn.started', 'thread.completed'].includes(eventType)) return null;
  if (eventType === 'turn.completed') {
    // Codex turn.completed usage is a cumulative running total
    const parsed = ev('status', 'Turn completed', rawLine, extractTokenUsage(event));
    parsed.tokenUsageCumulative = true;
    return parsed;
  }
  if (eventType === 'error') return { eventType: 'raw' as EventType, text: `Error: ${asString(event.message) || 'unknown error'}`, rawLine };
  if (eventType === 'turn.failed') {
    const err = asRecord(event.error);
    return ev('status', `Failed: ${asString(err.message)}`, rawLine);
  }

  if (eventType === 'item.started') {
    const item = asRecord(event.item);
    const itemType = asString(item.type);
    if (itemType === 'reasoning') return ev('thinking', 'Reasoning...', rawLine);
    if (itemType === 'command_execution') {
      const command = asString(item.command);
      return ev('tool_call', command ? `Running: ${truncateLabel(command, 80)}` : 'Running command...', rawLine);
    }
    if (itemType === 'function_call') {
      const name = asString(item.name);
      return ev('tool_call', name ? `Tool: ${name}` : 'Tool call', rawLine);
    }
    if (itemType === 'message') return ev('status', 'Generating response...', rawLine);
    return null;
  }

  if (eventType === 'item.completed') {
    const item = asRecord(event.item);
    const itemType = asString(item.type);
    const tokenUsage = extractTokenUsage(event);

    if (itemType === 'message') {
      const content = item.content;
      if (Array.isArray(content)) {
        const text = content.map((part) => asString(asRecord(part).text)).join('\n').trim();
        if (text) return ev('text', text, rawLine, tokenUsage);
      }
      return ev('status', 'Message completed', rawLine, tokenUsage);
    }

    if (itemType === 'reasoning') {
      const text = asString(item.text);
      if (text) return ev('thinking', text, rawLine, tokenUsage);
      const summary = item.summary;
      if (Array.isArray(summary)) {
        const summaryText = summary.map((s) => asString(asRecord(s).text)).join('\n').trim();
        if (summaryText) return ev('thinking', summaryText, rawLine, tokenUsage);
      }
      return ev('thinking', 'Reasoning completed', rawLine, tokenUsage);
    }

    if (itemType === 'command_execution') {
      const command = asString(item.command);
      const exitCode = item.exit_code;
      const status = asString(item.status);
      let label = command ? `Ran: ${truncateLabel(command, 80)}` : 'Command completed';
      if (status === 'completed' && exitCode != null) {
        label += exitCode === 0 ? ' \u2713' : ` (exit ${exitCode})`;
      }
      return ev('tool_call', label, rawLine, tokenUsage);
    }

    if (itemType === 'agent_message') {
      const text = asString(item.text);
      return text ? ev('text', text, rawLine, tokenUsage) : ev('status', 'Agent response received', rawLine, tokenUsage);
    }

    if (itemType === 'function_call') {
      const name = asString(item.name);
      const args = asString(item.arguments);
      let label = name ? `Tool: ${name}` : 'Tool call';
      if (args) {
        try {
          const argObj = JSON.parse(args);
          if (argObj && typeof argObj === 'object') {
            const cmd = asString(argObj.command) || asString(argObj.cmd) || asString(argObj.path);
            if (cmd) label += ` -> ${truncateLabel(cmd, 60)}`;
          }
        } catch { /* ignore */ }
      }
      return ev('tool_call', label, rawLine, tokenUsage);
    }

    if (itemType === 'function_call_output') return ev('status', 'Tool completed', rawLine, tokenUsage);
    return ev('status', `${itemType || 'Item'} completed`, rawLine, tokenUsage);
  }

  return null;
}

function extractClaudeUsage(obj: Record<string, unknown>): TokenUsage | null {
  const usage = asRecord(obj.usage);
  const inputTokens = Math.floor(
    asNumber(usage.input_tokens) +
    asNumber(usage.cache_creation_input_tokens) +
    asNumber(usage.cache_read_input_tokens),
  );
  const outputTokens = Math.floor(asNumber(usage.output_tokens));
  if (inputTokens === 0 && outputTokens === 0) return null;
  const cost = asNumber(obj.total_cost_usd);
  return { inputTokens, outputTokens, totalCost: cost > 0 ? cost : null };
}

function parseClaudeEvent(payload: unknown, rawLine: string): ParsedEvent | null {
  const event = asRecord(payload);
  const eventType = asString(event.type);

  if (eventType === 'system') return null;
  if (eventType === 'stream_event') return parseClaudeStreamEvent(asRecord(event.event), rawLine);

  // Skip 'assistant' events — they duplicate content already received via
  // stream_event deltas (content_block_start / content_block_delta).
  // Processing both causes every text block and tool call to appear twice.
  if (eventType === 'assistant') {
    return null;
  }

  if (eventType === 'result') {
    // result event carries the cumulative total for the entire run
    const tokenUsage = extractClaudeUsage(event);
    const resultText = asString(event.result);
    const base = resultText
      ? ev('text', resultText, rawLine, tokenUsage)
      : ev('status', asString(event.subtype) === 'error' ? 'Run failed' : 'Run completed', rawLine, tokenUsage);
    base.tokenUsageCumulative = true;
    return base;
  }

  return null;
}

function parseClaudeStreamEvent(inner: Record<string, unknown>, rawLine: string): ParsedEvent | null {
  const eventType = asString(inner.type);
  if (eventType === 'content_block_start') {
    const block = asRecord(inner.content_block);
    const blockType = asString(block.type);
    if (blockType === 'tool_use') {
      const name = asString(block.name);
      return ev('tool_call', name ? `Tool: ${name}` : 'Tool use', rawLine);
    }
    if (blockType === 'thinking') return ev('thinking', 'Thinking...', rawLine);
    return null;
  }
  if (eventType === 'content_block_delta') {
    const delta = asRecord(inner.delta);
    const deltaType = asString(delta.type);
    if (deltaType === 'text_delta') {
      const text = asString(delta.text);
      return text ? ev('text', text, rawLine) : null;
    }
    if (deltaType === 'thinking_delta') {
      const thinking = asString(delta.thinking);
      return thinking ? ev('thinking', thinking, rawLine) : null;
    }
    return null;
  }
  if (eventType === 'message_delta') {
    const delta = asRecord(inner.delta);
    const stopReason = asString(delta.stop_reason);
    if (stopReason === 'tool_use') return ev('status', 'Executing tools...', rawLine);
    if (stopReason) return ev('status', `Response complete (${stopReason})`, rawLine);
  }
  return null;
}

function parseOpenCodeEvent(payload: unknown, rawLine: string): ParsedEvent | null {
  const event = asRecord(payload);
  let eventType = asString(event.type);

  // Normalize SDK/event-stream shape (type: "message.part.updated") to CLI shape
  // SDK shape: { type: "message.part.updated", properties: { part: {...} } }
  // CLI shape: { type: "tool_use", part: {...} }
  let part = asRecord(event.part);
  if (eventType.startsWith('message.part.') || eventType.startsWith('message.step.')) {
    const properties = asRecord(event.properties);
    if (properties.part) {
      part = asRecord(properties.part);
    }
    // Map SDK event types to CLI event types
    const partType = asString(part.type);
    if (partType) eventType = partType;
    else if (eventType === 'message.step.started') eventType = 'step_start';
    else if (eventType === 'message.step.finished') eventType = 'step_finish';
  }

  if (eventType === 'reasoning') {
    const text = asString(part.text);
    return ev('thinking', text || 'Reasoning...', rawLine);
  }

  if (eventType === 'tool_use') {
    const toolName = asString(part.tool);
    const state = asRecord(part.state);
    const inputData = asRecord(state.input);
    const statusText = asString(state.status);
    const titleText = asString(state.title);

    // Build richer label from state.title or state.status if available
    let label = '';
    if (titleText) {
      label = truncateLabel(titleText, 80);
    } else if (toolName) {
      label = `Tool: ${toolName}`;
    } else {
      label = 'Tool use';
    }

    // Append key input fields for context
    const command = asString(inputData.command);
    const filePath = asString(inputData.file_path) || asString(inputData.path);
    const pattern = asString(inputData.pattern);
    if (command) label += ` -> ${truncateLabel(command, 70)}`;
    else if (filePath) label += ` -> ${truncateLabel(filePath, 70)}`;
    else if (pattern) label += ` -> ${truncateLabel(pattern, 70)}`;

    // Add status indicator if available
    if (statusText && statusText !== 'running') {
      label += ` (${statusText})`;
    }

    return ev('tool_call', label, rawLine);
  }

  if (eventType === 'text') {
    const text = asString(part.text);
    return text ? ev('text', text, rawLine) : null;
  }

  if (eventType === 'step_finish') {
    const tokens = asRecord(part.tokens);
    const cost = asNumber(part.cost);
    const reason = asString(part.finish_reason) || asString(part.reason);
    const inputTokens = Math.floor(asNumber(tokens.input));
    const outputTokens = Math.floor(asNumber(tokens.output));
    const reasoningTokens = Math.floor(asNumber(tokens.reasoning));
    let tokenUsage: TokenUsage | null = null;
    if (inputTokens > 0 || outputTokens > 0) {
      tokenUsage = {
        inputTokens,
        outputTokens: outputTokens + reasoningTokens,
        totalCost: cost > 0 ? cost : null,
      };
    }
    // Include reason in status text when available
    const statusText = reason ? `Step completed (${reason})` : 'Step completed';
    return ev('status', statusText, rawLine, tokenUsage);
  }

  if (eventType === 'step_start') {
    // Emit status event instead of returning null
    return ev('status', 'Step started', rawLine);
  }

  if (eventType === 'error') {
    const msg = asString(event.message) || asString(part.text) || asString(event.error);
    return { eventType: 'raw' as EventType, text: `Error: ${msg || 'unknown error'}`, rawLine };
  }

  // Catch-all: surface unknown event types instead of silently dropping them
  if (eventType) {
    const text = asString(part.text) || asString(event.message);
    if (text) return ev('text', text, rawLine);
    return ev('status', `[${eventType}]`, rawLine);
  }
  return null;
}

/** Parse OpenCode share link from non-JSON output line */
function parseOpenCodeShareLink(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  // Match OpenCode share URL pattern: https://opncd.ai/share/...
  const shareMatch = trimmed.match(/^(https:\/\/opncd\.ai\/share\/[a-zA-Z0-9_-]+)$/);
  if (shareMatch) {
    return ev('status', `Share link: ${shareMatch[1]}`, line);
  }
  return null;
}
