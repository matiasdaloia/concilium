import type { ChildProcess } from 'node:child_process';
import type { AgentConfig } from './agent-config.js';
import type { AgentResult } from './agent-result.js';
import type { ImageAttachment } from '../deliberation/deliberation.js';
import type { AgentProvider, RunnerCallbacks } from '../../ports/agent-provider.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('agent-executor');

export class RunController {
  private cancelled = false;
  private agentProcesses = new Map<string, ChildProcess>();

  register(agentKey: string, child: ChildProcess) {
    this.agentProcesses.set(agentKey, child);
  }

  unregister(agentKey: string) {
    this.agentProcesses.delete(agentKey);
  }

  cancel() {
    this.cancelled = true;
    for (const [, child] of this.agentProcesses) {
      const pid = child.pid;
      if (!pid) {
        try { child.kill(); } catch { /* ignore */ }
        continue;
      }
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
      setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, 3000);
    }
  }

  cancelAgent(agentKey: string): boolean {
    const child = this.agentProcesses.get(agentKey);
    if (!child) return false;

    const pid = child.pid;
    if (!pid) {
      try { child.kill(); } catch { /* ignore */ }
      this.agentProcesses.delete(agentKey);
      return true;
    }

    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, 3000);

    return true;
  }

  get isCancelled() {
    return this.cancelled;
  }
}

export async function runAgentsParallel(options: {
  agents: AgentConfig[];
  prompt: string;
  images?: ImageAttachment[];
  callbacks: RunnerCallbacks;
  controller?: RunController;
  providers: Map<string, AgentProvider>;
}): Promise<AgentResult[]> {
  log.info(`runAgentsParallel: starting ${options.agents.length} agents`);
  log.debug(`runAgentsParallel: agents:`, options.agents.map((a) => a.name));

  const controller = options.controller ?? new RunController();
  const tasks = options.agents.map((agent) =>
    runSingleAgent({
      agent,
      prompt: options.prompt,
      images: options.images,
      callbacks: options.callbacks,
      controller,
      providers: options.providers,
    }),
  );

  const results = await Promise.all(tasks);

  const successCount = results.filter((r) => r.status === 'success').length;
  log.info(`runAgentsParallel: completed - ${successCount}/${results.length} succeeded`);

  return results;
}

async function runSingleAgent(options: {
  agent: AgentConfig;
  prompt: string;
  images?: ImageAttachment[];
  callbacks: RunnerCallbacks;
  controller: RunController;
  providers: Map<string, AgentProvider>;
}): Promise<AgentResult> {
  const { agent, providers, controller } = options;
  const provider = providers.get(agent.id);

  if (!provider) {
    const agentKey = agent.instanceId ?? agent.id;
    options.callbacks.onStatus?.(agentKey, 'error');
    return {
      id: agent.id,
      agentKey,
      name: agent.name,
      status: 'error',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      rawOutput: [],
      normalizedPlan: `Error: No provider found for agent type "${agent.id}"`,
      errors: [`No provider found for agent type "${agent.id}"`],
      command: [],
      events: [],
    };
  }

  const abortController = new AbortController();
  const agentKey = agent.instanceId ?? agent.id;

  // Register an abort mechanism so the RunController can cancel SDK runs
  const pseudoChild = {
    pid: undefined,
    kill: () => abortController.abort(),
  } as unknown as ChildProcess;
  controller.register(agentKey, pseudoChild);

  try {
    const result = await provider.execute({
      agent,
      prompt: options.prompt,
      images: options.images,
      callbacks: options.callbacks,
      abortSignal: abortController.signal,
    });
    if (controller.isCancelled) {
      result.status = 'cancelled';
    }
    return result;
  } finally {
    controller.unregister(agentKey);
  }
}

/** Known Claude Code models */
export const CLAUDE_MODELS = [
  'sonnet',
  'opus',
  'haiku',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
];

/** Known Codex models */
export const CODEX_MODELS = [
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex',
  'gpt-5-codex',
  'gpt-5-codex-mini',
  'o3-codex',
];

/** Default models shown when agent is enabled but user hasn't picked one */
export const DEFAULT_AGENT_MODELS: Record<string, string> = {
  codex: 'gpt-5.2-codex',
  claude: 'claude-opus-4-6',
  opencode: '',
};

export interface AgentModelInfo {
  id: string;
  models: string[];
  defaultModel: string;
  supportsDiscovery: boolean;
}
