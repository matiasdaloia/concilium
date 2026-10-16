/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseClaudeEventLine } from './claude-parser.js';

const PLAN_STREAM = readFileSync(new URL('./__fixtures__/claude-plan.jsonl', import.meta.url), 'utf8')
  .split('\n');

function parseAll(lines: string[]) {
  return lines.flatMap((line) => parseClaudeEventLine(line));
}

describe('parseClaudeEventLine (stream-json fixture)', () => {
  it('should turn a planning session into thinking, tool, status and text events in order', () => {
    const summary = parseAll(PLAN_STREAM).map((e) => [e.eventType, e.text]);

    expect(summary).toEqual([
      ['thinking', 'Thinking...'],
      ['thinking', 'Look at the router first.'],
      ['tool_call', 'Tool: Grep'],
      ['status', 'Executing tools...'],
      ['thinking', 'Look at the router first.'],
      ['tool_call', 'Tool: Grep -> src/server/router.ts'],
      ['status', 'Executing tools...'],
      ['text', '## Plan\n'],
      ['text', 'Add middleware.'],
      ['status', 'Response complete (end_turn)'],
      ['status', 'Turn completed (end_turn)'],
      ['text', '## Plan\nAdd middleware.'],
    ]);
  });

  it('should report the final result usage, including cache tokens and cost, as a cumulative total', () => {
    const result = parseAll(PLAN_STREAM).at(-1);

    expect(result?.tokenUsage).toEqual({ inputTokens: 280, outputTokens: 42, totalCost: 0.0123 });
    expect(result?.tokenUsageCumulative).toBe(true);
  });

  it('should attach per-turn usage to the turn status event', () => {
    const turnEnds = parseAll(PLAN_STREAM).filter((e) => e.tokenUsage && !e.tokenUsageCumulative);

    expect(turnEnds.map((e) => e.tokenUsage)).toEqual([
      { inputTokens: 120, outputTokens: 12, totalCost: null },
      { inputTokens: 150, outputTokens: 30, totalCost: null },
    ]);
  });

  it('should keep the original line on every event', () => {
    const line = PLAN_STREAM.find((l) => l.includes('"text_delta"')) ?? '';

    expect(parseClaudeEventLine(line)[0].rawLine).toBe(line);
  });

  it('should label a shell tool call with its command', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
    });

    expect(parseClaudeEventLine(line).map((e) => e.text)).toEqual(['Tool: Bash -> npm test']);
  });

  it('should report a failed run without result text as "Run failed"', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error', usage: {} });

    expect(parseClaudeEventLine(line)).toMatchObject([{ eventType: 'status', text: 'Run failed', tokenUsage: null }]);
  });
});

describe('parseClaudeEventLine (malformed input)', () => {
  it('should return no events for blank lines', () => {
    expect(parseClaudeEventLine('')).toEqual([]);
    expect(parseClaudeEventLine('   ')).toEqual([]);
  });

  it('should pass non-JSON output through as a raw event without ANSI colors', () => {
    const line = '\x1B[31mError: rate limited\x1B[0m';

    expect(parseClaudeEventLine(line)).toEqual([{ eventType: 'raw', text: 'Error: rate limited', rawLine: line }]);
  });

  it('should pass a truncated JSON line through as raw text', () => {
    const line = '{"type":"stream_event","event":{"type":"content_bl';

    expect(parseClaudeEventLine(line)).toEqual([{ eventType: 'raw', text: line, rawLine: line }]);
  });

  it('should ignore JSON that is not a known event', () => {
    expect(parseClaudeEventLine('[1,2,3]')).toEqual([]);
    expect(parseClaudeEventLine('"just a string"')).toEqual([]);
    expect(parseClaudeEventLine('{"type":"user","message":{}}')).toEqual([]);
    expect(parseClaudeEventLine('{"type":"assistant","message":{"content":"not-an-array"}}')).toEqual([]);
  });
});
