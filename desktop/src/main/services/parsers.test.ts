import { describe, it, expect } from 'vitest';
import { parseEventLine } from './parsers';

describe('parseEventLine', () => {
  describe('OpenCode parsing', () => {
    it('should parse step_start as status event', () => {
      const line = JSON.stringify({ type: 'step_start', part: {} });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('status');
      expect(result?.text).toBe('Step started');
    });

    it('should parse tool_use with title from state', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'bash',
          state: {
            title: 'Running npm install',
            status: 'running',
            input: { command: 'npm install' }
          }
        }
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('tool_call');
      expect(result?.text).toContain('Running npm install');
      expect(result?.text).toContain('npm install');
    });

    it('should parse tool_use with status indicator when not running', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'read',
          state: {
            status: 'completed',
            input: { path: '/src/index.ts' }
          }
        }
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('tool_call');
      expect(result?.text).toContain('(completed)');
      expect(result?.text).toContain('/src/index.ts');
    });

    it('should parse tool_use with command input', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'bash',
          state: {
            input: { command: 'git status' }
          }
        }
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('tool_call');
      expect(result?.text).toContain('bash');
      expect(result?.text).toContain('git status');
    });

    it('should parse tool_use with file_path input', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'read',
          state: {
            input: { file_path: '/Users/test/src/app.ts' }
          }
        }
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('tool_call');
      expect(result?.text).toContain('/Users/test/src/app.ts');
    });

    it('should parse tool_use with pattern input', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'grep',
          state: {
            input: { pattern: 'function.*export' }
          }
        }
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('tool_call');
      expect(result?.text).toContain('function.*export');
    });

    it('should parse step_finish with reason', () => {
      const line = JSON.stringify({
        type: 'step_finish',
        part: {
          finish_reason: 'tool-calls',
          tokens: { input: 1000, output: 500, reasoning: 200 },
          cost: 0.05
        }
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('status');
      expect(result?.text).toBe('Step completed (tool-calls)');
      expect(result?.tokenUsage).toEqual({
        inputTokens: 1000,
        outputTokens: 700, // output + reasoning
        totalCost: 0.05
      });
    });

    it('should parse step_finish with alternative reason field', () => {
      const line = JSON.stringify({
        type: 'step_finish',
        part: {
          reason: 'stop',
          tokens: { input: 500, output: 300 }
        }
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('status');
      expect(result?.text).toBe('Step completed (stop)');
    });

    it('should parse step_finish without reason', () => {
      const line = JSON.stringify({
        type: 'step_finish',
        part: {
          tokens: { input: 100, output: 50 }
        }
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('status');
      expect(result?.text).toBe('Step completed');
    });

    it('should parse share URL as status event', () => {
      const line = 'https://opncd.ai/share/abc123xyz';
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('status');
      expect(result?.text).toBe('Share link: https://opncd.ai/share/abc123xyz');
    });

    it('should parse reasoning event as thinking', () => {
      const line = JSON.stringify({
        type: 'reasoning',
        part: { text: 'Let me think about this...' }
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('thinking');
      expect(result?.text).toBe('Let me think about this...');
    });

    it('should parse text event', () => {
      const line = JSON.stringify({
        type: 'text',
        part: { text: 'Here is the solution...' }
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('text');
      expect(result?.text).toBe('Here is the solution...');
    });

    it('should parse error event', () => {
      const line = JSON.stringify({
        type: 'error',
        message: 'API rate limit exceeded'
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('raw');
      expect(result?.text).toContain('Error:');
      expect(result?.text).toContain('API rate limit exceeded');
    });

    it('should surface unknown event types via fallback', () => {
      const line = JSON.stringify({
        type: 'some_new_event_type',
        part: { text: 'some content' }
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      // Unknown events with text content become text events
      expect(result?.eventType).toBe('text');
      expect(result?.text).toBe('some content');
    });

    it('should handle unknown event types without content as status', () => {
      const line = JSON.stringify({
        type: 'some_new_event_type',
        part: {}
      });
      const result = parseEventLine('opencode', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('status');
      expect(result?.text).toBe('[some_new_event_type]');
    });

    // SDK/event-stream shape compatibility tests
    describe('SDK shape normalization', () => {
      it('should normalize message.part.updated to tool_use', () => {
        const line = JSON.stringify({
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool_use',
              tool: 'bash',
              state: {
                input: { command: 'ls -la' }
              }
            }
          }
        });
        const result = parseEventLine('opencode', line);
        
        expect(result).not.toBeNull();
        expect(result?.eventType).toBe('tool_call');
        expect(result?.text).toContain('ls -la');
      });

      it('should normalize message.step.started to step_start', () => {
        const line = JSON.stringify({
          type: 'message.step.started',
          properties: { part: {} }
        });
        const result = parseEventLine('opencode', line);
        
        expect(result).not.toBeNull();
        expect(result?.eventType).toBe('status');
        expect(result?.text).toBe('Step started');
      });

      it('should normalize message.step.finished to step_finish', () => {
        const line = JSON.stringify({
          type: 'message.step.finished',
          properties: {
            part: {
              finish_reason: 'stop',
              tokens: { input: 100, output: 50 }
            }
          }
        });
        const result = parseEventLine('opencode', line);
        
        expect(result).not.toBeNull();
        expect(result?.eventType).toBe('status');
        expect(result?.text).toBe('Step completed (stop)');
      });
    });
  });

  describe('Non-JSON line handling', () => {
    it('should return raw event for non-JSON lines for non-OpenCode agents', () => {
      const line = 'Some random output text';
      const result = parseEventLine('codex', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('raw');
      expect(result?.text).toBe('Some random output text');
    });

    it('should strip ANSI codes from non-JSON lines', () => {
      const line = '\x1B[32mGreen text\x1B[0m';
      const result = parseEventLine('codex', line);
      
      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('raw');
      expect(result?.text).toBe('Green text');
    });

    it('should return null for empty lines', () => {
      expect(parseEventLine('opencode', '')).toBeNull();
      expect(parseEventLine('opencode', '   ')).toBeNull();
    });
  });
});
