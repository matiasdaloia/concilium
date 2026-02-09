/**
 * Event line parser for CLI subprocess output.
 *
 * Only Claude still uses the CLI subprocess path; OpenCode and Codex events
 * are handled by their respective SDK clients (opencode-client.ts and
 * codex-client.ts) and never pass through this module.
 */

import type { EventType, ParsedEvent, TokenUsage } from './types';

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

function ev(eventType: EventType, text: string, rawLine: string, tokenUsage?: TokenUsage | null): ParsedEvent {
  return { eventType, text, rawLine, tokenUsage };
}

/**
 * Parse a single line of JSON output from a Claude CLI subprocess.
 */
export function parseClaudeEventLine(line: string): ParsedEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    const cleaned = stripAnsi(trimmed);
    if (!cleaned) return [];
    return [{ eventType: 'raw', text: cleaned, rawLine: line }];
  }

  return parseClaudeEvent(payload, line);
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

function parseClaudeEvent(payload: unknown, rawLine: string): ParsedEvent[] {
  const event = asRecord(payload);
  const eventType = asString(event.type);

  if (eventType === 'system') return [];
  if (eventType === 'stream_event') return parseClaudeStreamEvent(asRecord(event.event), rawLine);

  // In --print mode, Claude emits turn-level 'assistant' events instead of
  // granular stream_event deltas. Extract tool calls, thinking blocks, and
  // status from the message content so the UI can show progress in real time.
  if (eventType === 'assistant') {
    return parseClaudeAssistantEvent(event, rawLine);
  }

  if (eventType === 'result') {
    // result event carries the cumulative total for the entire run
    const tokenUsage = extractClaudeUsage(event);
    const resultText = asString(event.result);
    const base = resultText
      ? ev('text', resultText, rawLine, tokenUsage)
      : ev('status', asString(event.subtype) === 'error' ? 'Run failed' : 'Run completed', rawLine, tokenUsage);
    base.tokenUsageCumulative = true;
    return [base];
  }

  return [];
}

/** Parse a Claude --print mode 'assistant' event into multiple semantic events.
 *  Each turn emits one assistant event whose message.content is an array of
 *  content blocks (thinking, tool_use, text). We fan these out into individual
 *  ParsedEvents so the UI can show progress between turns. */
function parseClaudeAssistantEvent(event: Record<string, unknown>, rawLine: string): ParsedEvent[] {
  const message = asRecord(event.message);
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const events: ParsedEvent[] = [];

  // Only extract usage from completed turns (stop_reason is set).
  // With --include-partial-messages, Claude emits multiple assistant events
  // per API turn. Each partial carries the same turn's usage, but since they
  // are not marked cumulative the hook sums them — inflating the live count.
  const stopReason = asString(message.stop_reason);
  const tokenUsage = stopReason ? extractClaudeUsage(message) : null;

  for (const block of content) {
    const b = asRecord(block);
    const blockType = asString(b.type);

    if (blockType === 'tool_use') {
      const name = asString(b.name);
      const input = asRecord(b.input);
      let label = name ? `Tool: ${name}` : 'Tool use';
      const filePath = asString(input.file_path) || asString(input.path);
      const command = asString(input.command);
      if (command) label += ` -> ${truncateLabel(command, 60)}`;
      else if (filePath) label += ` -> ${truncateLabel(filePath, 60)}`;
      events.push(ev('tool_call', label, rawLine));
    } else if (blockType === 'thinking') {
      const text = asString(b.thinking);
      events.push(ev('thinking', text || 'Thinking...', rawLine));
    }
    // Skip 'text' blocks — the final 'result' event carries the complete
    // text output. Emitting text here would cause duplicate content.
  }

  // Emit a status event based on stop_reason so the UI shows turn boundaries
  if (stopReason === 'tool_use') {
    events.push(ev('status', 'Executing tools...', rawLine, tokenUsage));
  } else if (stopReason) {
    events.push(ev('status', `Turn completed (${stopReason})`, rawLine, tokenUsage));
  } else if (events.length === 0) {
    // Fallback: assistant event with no recognized blocks
    events.push(ev('status', 'Processing...', rawLine, tokenUsage));
  } else if (tokenUsage) {
    // Attach usage to the last event if we have it
    events[events.length - 1].tokenUsage = tokenUsage;
  }

  return events;
}

function parseClaudeStreamEvent(inner: Record<string, unknown>, rawLine: string): ParsedEvent[] {
  const eventType = asString(inner.type);
  if (eventType === 'content_block_start') {
    const block = asRecord(inner.content_block);
    const blockType = asString(block.type);
    if (blockType === 'tool_use') {
      const name = asString(block.name);
      return [ev('tool_call', name ? `Tool: ${name}` : 'Tool use', rawLine)];
    }
    if (blockType === 'thinking') return [ev('thinking', 'Thinking...', rawLine)];
    return [];
  }
  if (eventType === 'content_block_delta') {
    const delta = asRecord(inner.delta);
    const deltaType = asString(delta.type);
    if (deltaType === 'text_delta') {
      const text = asString(delta.text);
      return text ? [ev('text', text, rawLine)] : [];
    }
    if (deltaType === 'thinking_delta') {
      const thinking = asString(delta.thinking);
      return thinking ? [ev('thinking', thinking, rawLine)] : [];
    }
    return [];
  }
  if (eventType === 'message_delta') {
    const delta = asRecord(inner.delta);
    const stopReason = asString(delta.stop_reason);
    if (stopReason === 'tool_use') return [ev('status', 'Executing tools...', rawLine)];
    if (stopReason) return [ev('status', `Response complete (${stopReason})`, rawLine)];
  }
  return [];
}
