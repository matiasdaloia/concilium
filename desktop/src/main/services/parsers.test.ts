import { describe, it, expect } from 'vitest';
import { parseClaudeEventLine } from './parsers';

describe('parseClaudeEventLine', () => {
  it('should return empty for system events', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init' });
    const results = parseClaudeEventLine(line);
    expect(results).toHaveLength(0);
  });

  it('should parse assistant event with tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1000, output_tokens: 200 }
      }
    });
    const results = parseClaudeEventLine(line);

    // 2 tool_call events + 1 status event ("Executing tools...")
    expect(results).toHaveLength(3);
    expect(results[0].eventType).toBe('tool_call');
    expect(results[0].text).toContain('Tool: Read');
    expect(results[0].text).toContain('/src/app.ts');
    expect(results[1].eventType).toBe('tool_call');
    expect(results[1].text).toContain('Tool: Bash');
    expect(results[1].text).toContain('npm test');
    expect(results[2].eventType).toBe('status');
    expect(results[2].text).toBe('Executing tools...');
    expect(results[2].tokenUsage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      totalCost: null,
    });
  });

  it('should parse assistant event with thinking block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Let me analyze this code...' },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 500, output_tokens: 100 }
      }
    });
    const results = parseClaudeEventLine(line);

    // thinking + tool_call + status
    expect(results).toHaveLength(3);
    expect(results[0].eventType).toBe('thinking');
    expect(results[0].text).toBe('Let me analyze this code...');
    expect(results[1].eventType).toBe('tool_call');
    expect(results[1].text).toContain('Tool: Grep');
    expect(results[2].eventType).toBe('status');
    expect(results[2].text).toBe('Executing tools...');
  });

  it('should skip text blocks in assistant events (result event carries final text)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Here is my analysis...' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 800, output_tokens: 300 }
      }
    });
    const results = parseClaudeEventLine(line);

    // Only the status event — text blocks are skipped to avoid duplication
    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe('status');
    expect(results[0].text).toBe('Turn completed (end_turn)');
  });

  it('should parse assistant event with empty content as fallback status', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [],
        usage: { input_tokens: 100, output_tokens: 10 }
      }
    });
    const results = parseClaudeEventLine(line);

    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe('status');
    expect(results[0].text).toBe('Processing...');
  });

  it('should parse result event with text', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Here is the final summary of changes.',
      usage: { input_tokens: 5000, output_tokens: 1500 },
      total_cost_usd: 0.12,
    });
    const results = parseClaudeEventLine(line);

    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe('text');
    expect(results[0].text).toBe('Here is the final summary of changes.');
    expect(results[0].tokenUsageCumulative).toBe(true);
    expect(results[0].tokenUsage?.totalCost).toBe(0.12);
  });

  it('should parse result event error subtype', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error',
      result: '',
      usage: { input_tokens: 100, output_tokens: 0 },
    });
    const results = parseClaudeEventLine(line);

    expect(results).toHaveLength(1);
    expect(results[0].eventType).toBe('status');
    expect(results[0].text).toBe('Run failed');
    expect(results[0].tokenUsageCumulative).toBe(true);
  });

  it('should parse assistant event with cache token usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/main.ts' } },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 300,
          output_tokens: 150,
        }
      }
    });
    const results = parseClaudeEventLine(line);

    const statusEvent = results.find(e => e.eventType === 'status');
    expect(statusEvent?.tokenUsage).toEqual({
      inputTokens: 1000, // 200 + 500 + 300
      outputTokens: 150,
      totalCost: null,
    });
  });

  // Stream event tests
  describe('stream_event parsing', () => {
    it('should parse content_block_start tool_use', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Write' }
        }
      });
      const results = parseClaudeEventLine(line);
      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe('tool_call');
      expect(results[0].text).toBe('Tool: Write');
    });

    it('should parse content_block_delta text_delta', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello world' }
        }
      });
      const results = parseClaudeEventLine(line);
      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe('text');
      expect(results[0].text).toBe('Hello world');
    });

    it('should parse message_delta with tool_use stop_reason', () => {
      const line = JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' }
        }
      });
      const results = parseClaudeEventLine(line);
      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe('status');
      expect(results[0].text).toBe('Executing tools...');
    });
  });

  describe('Non-JSON line handling', () => {
    it('should return raw event for non-JSON lines', () => {
      const line = 'Some random output text';
      const results = parseClaudeEventLine(line);

      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe('raw');
      expect(results[0].text).toBe('Some random output text');
    });

    it('should strip ANSI codes from non-JSON lines', () => {
      const line = '\x1B[32mGreen text\x1B[0m';
      const results = parseClaudeEventLine(line);

      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe('raw');
      expect(results[0].text).toBe('Green text');
    });

    it('should return empty array for empty lines', () => {
      expect(parseClaudeEventLine('')).toHaveLength(0);
      expect(parseClaudeEventLine('   ')).toHaveLength(0);
    });
  });
});
