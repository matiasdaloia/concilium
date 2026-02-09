import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentConfig, AgentId, AgentResult, AgentStatus, ParsedEvent } from './types';
import { buildCommand, mergedEnv } from './commands';
import { parseEventLine } from './parsers';
import { createLogger } from './logger';

const log = createLogger('runner');

/** agentKey is instanceId if available, otherwise AgentId (provider) for legacy */
export type StatusCallback = (agentKey: string, status: AgentStatus) => void;
export type EventCallback = (agentKey: string, event: ParsedEvent) => void;

export interface RunnerCallbacks {
  onStatus?: StatusCallback;
  onEvent?: EventCallback;
}

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
      if (!pid) continue;
      try {
        // Kill the entire process group so child processes of the agent
        // (e.g. opencode's internal subprocesses) are also terminated.
        process.kill(-pid, 'SIGTERM');
      } catch {
        // process.kill(-pid) fails if the child isn't a group leader;
        // fall back to killing just the child.
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
      // Force-kill after 3s if the process ignores SIGTERM
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
      this.agentProcesses.delete(agentKey);
      return false;
    }

    try {
      // Kill the entire process group so child processes of the agent
      // (e.g. opencode's internal subprocesses) are also terminated.
      process.kill(-pid, 'SIGTERM');
    } catch {
      // process.kill(-pid) fails if the child isn't a group leader;
      // fall back to killing just the child.
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    // Force-kill after 3s if the process ignores SIGTERM
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
  callbacks: RunnerCallbacks;
  controller?: RunController;
}): Promise<AgentResult[]> {
  log.info(`runAgentsParallel: starting ${options.agents.length} agents`);
  log.debug(`runAgentsParallel: agents:`, options.agents.map(a => a.name));
  
  const controller = options.controller ?? new RunController();
  const tasks = options.agents.map((agent) =>
    runSingleAgent({ agent, prompt: options.prompt, callbacks: options.callbacks, controller }),
  );
  
  const results = await Promise.all(tasks);
  
  const successCount = results.filter(r => r.status === 'success').length;
  log.info(`runAgentsParallel: completed - ${successCount}/${results.length} succeeded`);
  
  return results;
}

async function runSingleAgent(options: {
  agent: AgentConfig;
  prompt: string;
  callbacks: RunnerCallbacks;
  controller: RunController;
}): Promise<AgentResult> {
  const spec = buildCommand({
    agentId: options.agent.id,
    cwd: options.agent.cwd,
    prompt: options.prompt,
    model: options.agent.model,
  });

  // Use instanceId as the unique key if available, otherwise fall back to provider id
  const agentKey = options.agent.instanceId ?? options.agent.id;

  return runProcess({
    agentId: options.agent.id,
    agentKey,
    name: options.agent.name,
    cwd: options.agent.cwd,
    command: spec.command,
    args: spec.args,
    env: mergedEnv(spec.env),
    callbacks: options.callbacks,
    controller: options.controller,
  });
}

function runProcess(options: {
  agentId: AgentId;
  /** Unique key for callbacks (instanceId or agentId) */
  agentKey: string;
  name: string;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  callbacks: RunnerCallbacks;
  controller: RunController;
}): Promise<AgentResult> {
  return new Promise((resolve) => {
    const { agentId, agentKey, name, command, args, env, callbacks, controller } = options;
    const startedAt = new Date().toISOString();
    
    log.debug(`runProcess: spawning ${name} (${agentId})`);
    log.debug(`runProcess: command: ${command} ${args.join(' ')}`);
    log.debug(`runProcess: cwd: ${options.cwd}`);
    
    callbacks.onStatus?.(agentKey, 'running');

    const rawOutput: string[] = [];
    const events: ParsedEvent[] = [];
    const planFragments: string[] = [];
    const errors: string[] = [];
    const spawnedAt = Date.now();

    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Create a new process group so we can kill the entire tree on cancel.
      detached: true,
    });

    log.debug(`runProcess: ${name} spawned with PID ${child.pid}`);
    controller.register(agentKey, child);

    // Track time-to-first-byte from the subprocess to diagnose streaming delays.
    // If this fires quickly, the model is streaming — any UI lag is downstream.
    // If this fires late, the delay is in the subprocess (OpenCode/model TTFT).
    let firstDataLogged = false;
    const logFirstData = (stream: string) => {
      if (firstDataLogged) return;
      firstDataLogged = true;
      const elapsed = Date.now() - spawnedAt;
      log.info(`runProcess: ${name} first data on ${stream} after ${elapsed}ms`);
    };

    const handleLine = (line: string) => {
      rawOutput.push(line);
      const parsedEvents = parseEventLine(agentId, line);
      for (const parsed of parsedEvents) {
        // Log timing for the first few parsed events to diagnose streaming latency.
        if (events.length < 3) {
          const elapsed = Date.now() - spawnedAt;
          log.debug(`runProcess: ${name} event #${events.length} at +${elapsed}ms: type=${parsed.eventType}`);
        }

        events.push(parsed);
        callbacks.onEvent?.(agentKey, parsed);
        if (parsed.eventType === 'text') planFragments.push(parsed.text);
        if (parsed.eventType === 'raw' && line.toLowerCase().includes('error')) errors.push(line);
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
      controller.unregister(agentKey);

      let status: AgentStatus;
      if (controller.isCancelled) {
        status = 'cancelled';
        log.warn(`runProcess: ${name} cancelled`);
      } else if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        // Process was killed (likely via cancelAgent)
        status = 'aborted';
        log.warn(`runProcess: ${name} aborted (killed by signal ${signal})`);
      } else if (code === 0) {
        status = 'success';
        log.info(`runProcess: ${name} completed successfully`);
      } else {
        status = 'error';
        log.error(`runProcess: ${name} exited with code ${code}`);
      }

      callbacks.onStatus?.(agentKey, status);
      const normalizedPlan = normalizePlan(planFragments, rawOutput);
      const endedAt = new Date().toISOString();
      
      log.debug(`runProcess: ${name} stats - rawOutput: ${rawOutput.length} lines, events: ${events.length}, plan: ${normalizedPlan.length} chars`);

      resolve({
        id: agentId,
        agentKey,
        name,
        status,
        startedAt,
        endedAt,
        rawOutput,
        normalizedPlan,
        errors,
        command: [command, ...args],
        events,
      });
    });

    child.on('error', (err) => {
      controller.unregister(agentKey);
      log.error(`runProcess: ${name} spawn error:`, err.message);
      callbacks.onStatus?.(agentKey, 'error');
      resolve({
        id: agentId,
        agentKey,
        name,
        status: 'error',
        startedAt,
        endedAt: new Date().toISOString(),
        rawOutput,
        normalizedPlan: `Process error: ${err.message}`,
        errors: [err.message],
        command: [command, ...args],
        events,
      });
    });
  });
}

// ── Model discovery ──────────────────────────────────────────────

/** Known Claude Code models (no programmatic listing available) */
const CLAUDE_MODELS = [
  'sonnet',
  'opus',
  'haiku',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
];

/** Known Codex models (no programmatic listing available) */
const CODEX_MODELS = [
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

async function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: string[] = [];
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => chunks.push(line));
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on('line', (line) => chunks.push(line));
    }
    child.on('close', () => resolve(chunks.join('\n')));
    child.on('error', () => resolve(''));
    // Timeout after 10s
    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(chunks.join('\n'));
    }, 10_000);
  });
}

function parseProviders(raw: string): Set<string> {
  const providers = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (
      !trimmed
      || trimmed.toLowerCase().startsWith('opencode')
      || trimmed.toLowerCase().startsWith('error')
      || trimmed.includes('service=models.dev')
      || trimmed.toLowerCase().startsWith('options:')
      || trimmed.toLowerCase().startsWith('commands:')
    ) continue;
    const token = trimmed.split(/\s+/)[0];
    if (token) providers.add(token.toLowerCase());
  }
  return providers;
}

function parseModels(raw: string): string[] {
  const models: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    // Skip empty lines and error messages
    if (!trimmed || trimmed.toLowerCase().startsWith('error')) continue;
    // Valid model IDs contain at least one slash (e.g., google/gemini-2.5-pro or openrouter/anthropic/claude-sonnet-4)
    if (trimmed.includes('/') && !trimmed.includes(' ')) {
      models.push(trimmed);
    }
  }
  return models.sort();
}

import { resolveOpenCodeBinary } from './commands';

export async function discoverOpenCodeModels(): Promise<string[]> {
  const binary = resolveOpenCodeBinary();
  const [providersRaw, modelsRaw] = await Promise.all([
    runCapture(binary, ['auth', 'list']),
    runCapture(binary, ['models']),
  ]);
  const providers = parseProviders(providersRaw);
  const allModels = parseModels(modelsRaw);
  if (!allModels.length) return [];
  if (!providers.size) {
    const lower = modelsRaw.toLowerCase();
    if (lower.includes('service=models.dev') || lower.includes('unable to connect') || lower.trim().startsWith('error')) {
      return [];
    }
    return allModels;
  }
  const filtered = allModels.filter((m) => providers.has(m.split('/')[0].toLowerCase()));
  return filtered.length ? filtered : allModels;
}

export interface AgentModelInfo {
  id: string;
  models: string[];
  defaultModel: string;
  supportsDiscovery: boolean;
}

export async function discoverModelsForAllAgents(): Promise<AgentModelInfo[]> {
  let openCodeModels: string[] = [];
  try {
    openCodeModels = await discoverOpenCodeModels();
  } catch {
    // OpenCode not installed or not configured
  }

  return [
    {
      id: 'codex',
      models: CODEX_MODELS,
      defaultModel: DEFAULT_AGENT_MODELS.codex,
      supportsDiscovery: false,
    },
    {
      id: 'claude',
      models: CLAUDE_MODELS,
      defaultModel: DEFAULT_AGENT_MODELS.claude,
      supportsDiscovery: false,
    },
    {
      id: 'opencode',
      models: openCodeModels,
      defaultModel: openCodeModels[0] ?? '',
      supportsDiscovery: true,
    },
  ];
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
