import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProvider, AgentExecutionConfig } from '../ports/agent-provider.js';
import type { AgentResult } from '../domain/agent/agent-result.js';
import type { AgentStatus } from '../domain/agent/agent-config.js';
import type { ParsedEvent } from '../domain/agent/parsed-event.js';
import type { CommandSpec } from '../domain/council/council-config.js';
import { wrapPromptForResearch } from '../domain/deliberation/prompts.js';
import { parseClaudeEventLine } from './parsers/claude-parser.js';
import { createLogger } from '../shared/logger.js';
import { CLAUDE_MODELS, DEFAULT_AGENT_MODELS } from '../domain/agent/agent-executor.js';

const log = createLogger('claude-provider');

function buildClaudeCommand(input: { prompt: string; model?: string | null }): CommandSpec {
  const args = [
    '--verbose',
    '--print',
    '--output-format', 'stream-json',
    '--permission-mode', 'plan',
    '--include-partial-messages',
    '--no-session-persistence',
    '--disallowedTools', 'Write', 'Edit', 'NotebookEdit',
  ];
  if (input.model?.trim()) {
    args.push('--model', input.model.trim());
  }
  args.push(wrapPromptForResearch(input.prompt));
  return { command: 'claude', args, env: {} };
}

function mergedEnv(commandEnv?: Record<string, string>): Record<string, string> {
  return { ...process.env as Record<string, string>, ...commandEnv };
}

function normalizePlan(planFragments: string[], rawOutput: string[]): string {
  const text = planFragments.join('').trim();
  if (text) return text;

  const fallbackLines: string[] = [];
  for (const line of rawOutput) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('{') || stripped.startsWith('[')) continue;
    fallbackLines.push(stripped);
  }
  const fallback = fallbackLines.slice(-80).join('\n').trim();
  return fallback || 'No normalized plan could be extracted from output.';
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly name = 'Claude';

  async discoverModels(): Promise<string[]> {
    return CLAUDE_MODELS;
  }

  execute(config: AgentExecutionConfig): Promise<AgentResult> {
    const { agent, prompt, callbacks } = config;
    const spec = buildClaudeCommand({ prompt, model: agent.model });
    const agentKey = agent.instanceId ?? agent.id;

    return new Promise((resolve) => {
      const startedAt = new Date().toISOString();

      log.debug(`execute: spawning ${agent.name}`);
      callbacks.onStatus?.(agentKey, 'running');

      const rawOutput: string[] = [];
      const events: ParsedEvent[] = [];
      const planFragments: string[] = [];
      const errors: string[] = [];
      const spawnedAt = Date.now();

      const child = spawn(spec.command, spec.args, {
        cwd: agent.cwd,
        env: mergedEnv(spec.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      log.debug(`execute: ${agent.name} spawned with PID ${child.pid}`);

      // Handle abort signal
      if (config.abortSignal) {
        config.abortSignal.addEventListener('abort', () => {
          const pid = child.pid;
          if (pid) {
            try { process.kill(-pid, 'SIGTERM'); } catch { /* ignore */ }
            setTimeout(() => {
              try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
            }, 3000);
          }
        }, { once: true });
      }

      let firstDataLogged = false;
      const logFirstData = (stream: string) => {
        if (firstDataLogged) return;
        firstDataLogged = true;
        const elapsed = Date.now() - spawnedAt;
        log.info(`execute: ${agent.name} first data on ${stream} after ${elapsed}ms`);
      };

      const handleLine = (line: string) => {
        rawOutput.push(line);
        const parsedEvents = parseClaudeEventLine(line);
        for (const parsed of parsedEvents) {
          events.push(parsed);
          callbacks.onEvent?.(agentKey, parsed);
          if (parsed.eventType === 'text') planFragments.push(parsed.text);
          if (parsed.eventType === 'raw' && line.toLowerCase().includes('error'))
            errors.push(line);
        }
      };

      if (child.stdout) {
        child.stdout.once('data', () => logFirstData('stdout'));
        const rl = createInterface({ input: child.stdout });
        rl.on('line', handleLine);
      }
      if (child.stderr) {
        child.stderr.once('data', () => logFirstData('stderr'));
        const rl = createInterface({ input: child.stderr });
        rl.on('line', handleLine);
      }

      child.on('close', (code, signal) => {
        let status: AgentStatus;
        if (config.abortSignal?.aborted) {
          status = 'cancelled';
        } else if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          status = 'aborted';
        } else if (code === 0) {
          status = 'success';
        } else {
          status = 'error';
        }

        callbacks.onStatus?.(agentKey, status);
        const normalizedPlan = normalizePlan(planFragments, rawOutput);
        const endedAt = new Date().toISOString();

        resolve({
          id: 'claude',
          agentKey,
          name: agent.name,
          status,
          startedAt,
          endedAt,
          rawOutput: [],
          normalizedPlan,
          errors,
          command: [spec.command, ...spec.args],
          events,
        });
      });

      child.on('error', (err) => {
        log.error(`execute: ${agent.name} spawn error:`, err.message);
        callbacks.onStatus?.(agentKey, 'error');
        resolve({
          id: 'claude',
          agentKey,
          name: agent.name,
          status: 'error',
          startedAt,
          endedAt: new Date().toISOString(),
          rawOutput: [],
          normalizedPlan: `Process error: ${err.message}`,
          errors: [err.message],
          command: [spec.command, ...spec.args],
          events,
        });
      });
    });
  }
}
