import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { runCodexSdk } from "./codex-client";
import { buildClaudeCommand, mergedEnv } from "./commands";
import { createLogger } from "./logger";
import { ensureOpenCodeServer, runOpenCodeSdk } from "./opencode-client";
import { parseClaudeEventLine } from "./parsers";
import type {
  AgentConfig,
  AgentResult,
  AgentStatus,
  ImageAttachment,
  ParsedEvent,
} from "./types";

const log = createLogger("runner");

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
      if (!pid) {
        // SDK-based agents use pseudo-children without a pid.
        // Calling kill() triggers their AbortController.
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already exited */
        }
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, 3000);
    }
  }

  cancelAgent(agentKey: string): boolean {
    const child = this.agentProcesses.get(agentKey);
    if (!child) return false;

    const pid = child.pid;
    if (!pid) {
      // SDK-based agents register a pseudo-child with no pid; calling kill()
      // triggers the AbortController instead.
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      this.agentProcesses.delete(agentKey);
      return true;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already exited */
      }
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
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
}): Promise<AgentResult[]> {
  log.info(`runAgentsParallel: starting ${options.agents.length} agents`);
  log.debug(
    `runAgentsParallel: agents:`,
    options.agents.map((a) => a.name),
  );

  const controller = options.controller ?? new RunController();
  const tasks = options.agents.map((agent) =>
    runSingleAgent({
      agent,
      prompt: options.prompt,
      images: options.images,
      callbacks: options.callbacks,
      controller,
    }),
  );

  const results = await Promise.all(tasks);

  const successCount = results.filter((r) => r.status === "success").length;
  log.info(
    `runAgentsParallel: completed - ${successCount}/${results.length} succeeded`,
  );

  return results;
}

async function runSingleAgent(options: {
  agent: AgentConfig;
  prompt: string;
  images?: ImageAttachment[];
  callbacks: RunnerCallbacks;
  controller: RunController;
}): Promise<AgentResult> {
  const { agent } = options;

  // OpenCode: always via SDK (server must be initialized at app startup)
  if (agent.id === "opencode") {
    return runViaSdk(options, (abortSignal) =>
      runOpenCodeSdk({
        agent,
        prompt: options.prompt,
        images: options.images,
        callbacks: options.callbacks,
        sdkConfig: {},
        abortSignal,
      }),
    );
  }

  // Codex: always via SDK (read-only sandbox)
  if (agent.id === "codex") {
    return runViaSdk(options, (abortSignal) =>
      runCodexSdk({
        agent,
        prompt: options.prompt,
        callbacks: options.callbacks,
        sdkConfig: {},
        abortSignal,
      }),
    );
  }

  // Claude: still uses CLI subprocess
  const spec = buildClaudeCommand({
    prompt: options.prompt,
    model: agent.model,
  });

  const agentKey = agent.instanceId ?? agent.id;

  return runClaudeProcess({
    agentKey,
    name: agent.name,
    cwd: agent.cwd,
    command: spec.command,
    args: spec.args,
    env: mergedEnv(spec.env),
    callbacks: options.callbacks,
    controller: options.controller,
  });
}

/** Shared helper for running an agent via an SDK with abort support */
async function runViaSdk(
  options: { agent: AgentConfig; controller: RunController },
  sdkRunner: (abortSignal: AbortSignal) => Promise<AgentResult>,
): Promise<AgentResult> {
  const abortController = new AbortController();
  const agentKey = options.agent.instanceId ?? options.agent.id;

  // Register an abort mechanism so the RunController can cancel SDK runs
  const pseudoChild = {
    pid: undefined,
    kill: () => abortController.abort(),
  } as unknown as ChildProcess;
  options.controller.register(agentKey, pseudoChild);

  try {
    const result = await sdkRunner(abortController.signal);
    if (options.controller.isCancelled) {
      result.status = "cancelled";
    }
    return result;
  } finally {
    options.controller.unregister(agentKey);
  }
}

/**
 * Spawn a Claude CLI subprocess and stream events.
 * This is the only agent that still uses process spawning.
 */
function runClaudeProcess(options: {
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
    const { agentKey, name, command, args, env, callbacks, controller } =
      options;
    const startedAt = new Date().toISOString();

    log.debug(`runClaudeProcess: spawning ${name}`);
    log.debug(`runClaudeProcess: command: ${command} ${args.join(" ")}`);

    callbacks.onStatus?.(agentKey, "running");

    const rawOutput: string[] = [];
    const events: ParsedEvent[] = [];
    const planFragments: string[] = [];
    const errors: string[] = [];
    const spawnedAt = Date.now();

    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    log.debug(`runClaudeProcess: ${name} spawned with PID ${child.pid}`);
    controller.register(agentKey, child);

    let firstDataLogged = false;
    const logFirstData = (stream: string) => {
      if (firstDataLogged) return;
      firstDataLogged = true;
      const elapsed = Date.now() - spawnedAt;
      log.info(
        `runClaudeProcess: ${name} first data on ${stream} after ${elapsed}ms`,
      );
    };

    const handleLine = (line: string) => {
      rawOutput.push(line);
      const parsedEvents = parseClaudeEventLine(line);
      for (const parsed of parsedEvents) {
        if (events.length < 3) {
          const elapsed = Date.now() - spawnedAt;
          log.debug(
            `runClaudeProcess: ${name} event #${events.length} at +${elapsed}ms: type=${parsed.eventType}`,
          );
        }

        events.push(parsed);
        callbacks.onEvent?.(agentKey, parsed);
        if (parsed.eventType === "text") planFragments.push(parsed.text);
        if (parsed.eventType === "raw" && line.toLowerCase().includes("error"))
          errors.push(line);
      }
    };

    if (child.stdout) {
      child.stdout.once("data", () => logFirstData("stdout"));
      const rl = createInterface({ input: child.stdout });
      rl.on("line", handleLine);
    }
    if (child.stderr) {
      child.stderr.once("data", () => logFirstData("stderr"));
      const rl = createInterface({ input: child.stderr });
      rl.on("line", handleLine);
    }

    child.on("close", (code, signal) => {
      controller.unregister(agentKey);

      let status: AgentStatus;
      if (controller.isCancelled) {
        status = "cancelled";
        log.warn(`runClaudeProcess: ${name} cancelled`);
      } else if (signal === "SIGTERM" || signal === "SIGKILL") {
        status = "aborted";
        log.warn(
          `runClaudeProcess: ${name} aborted (killed by signal ${signal})`,
        );
      } else if (code === 0) {
        status = "success";
        log.info(`runClaudeProcess: ${name} completed successfully`);
      } else {
        status = "error";
        log.error(`runClaudeProcess: ${name} exited with code ${code}`);
      }

      callbacks.onStatus?.(agentKey, status);
      const normalizedPlan = normalizePlan(planFragments, rawOutput);
      const endedAt = new Date().toISOString();

      log.debug(
        `runClaudeProcess: ${name} stats - rawOutput: ${rawOutput.length} lines, events: ${events.length}, plan: ${normalizedPlan.length} chars`,
      );

      resolve({
        id: "claude",
        agentKey,
        name,
        status,
        startedAt,
        endedAt,
        rawOutput: [],
        normalizedPlan,
        errors,
        command: [command, ...args],
        events,
      });
    });

    child.on("error", (err) => {
      controller.unregister(agentKey);
      log.error(`runClaudeProcess: ${name} spawn error:`, err.message);
      callbacks.onStatus?.(agentKey, "error");
      resolve({
        id: "claude",
        agentKey,
        name,
        status: "error",
        startedAt,
        endedAt: new Date().toISOString(),
        rawOutput: [],
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
  "sonnet",
  "opus",
  "haiku",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
];

/** Known Codex models */
const CODEX_MODELS = [
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5-codex",
  "gpt-5-codex-mini",
  "o3-codex",
];

/** Default models shown when agent is enabled but user hasn't picked one */
export const DEFAULT_AGENT_MODELS: Record<string, string> = {
  codex: "gpt-5.2-codex",
  claude: "claude-opus-4-6",
  opencode: "",
};

/**
 * Discover available OpenCode models via the SDK.
 * Waits for the server that was initialized at app startup.
 */
export async function discoverOpenCodeModels(): Promise<string[]> {
  try {
    const { client } = await ensureOpenCodeServer({});
    const providersRes = await client.config.providers();
    const providersData = providersRes.data;

    const models: string[] = [];
    // SDK returns { providers: Array<Provider>, default: object }
    // Provider has: { id, name, source, env, key?, options, models: { [modelId]: Model } }
    if (
      providersData &&
      typeof providersData === "object" &&
      "providers" in providersData
    ) {
      const providers = (
        providersData as {
          providers?: Array<{ id: string; models?: Record<string, unknown> }>;
        }
      ).providers;
      if (Array.isArray(providers)) {
        for (const provider of providers) {
          const providerId = provider.id;
          if (provider.models && typeof provider.models === "object") {
            for (const modelId of Object.keys(provider.models)) {
              models.push(`${providerId}/${modelId}`);
            }
          }
        }
      }
    }

    log.info(`discoverOpenCodeModels: found ${models.length} models`);
    if (models.length === 0) {
      log.warn(
        "discoverOpenCodeModels: no models found — check OpenCode provider configuration",
      );
    }
    return models.sort();
  } catch (err) {
    log.warn(
      "discoverOpenCodeModels: failed to discover via SDK:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
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
      id: "codex",
      models: CODEX_MODELS,
      defaultModel: DEFAULT_AGENT_MODELS.codex,
      supportsDiscovery: false,
    },
    {
      id: "claude",
      models: CLAUDE_MODELS,
      defaultModel: DEFAULT_AGENT_MODELS.claude,
      supportsDiscovery: false,
    },
    {
      id: "opencode",
      models: openCodeModels,
      defaultModel: openCodeModels[0] ?? "",
      supportsDiscovery: true,
    },
  ];
}

function normalizePlan(planFragments: string[], rawOutput: string[]): string {
  const text = planFragments.join("").trim();
  if (text) return text;

  const fallbackLines: string[] = [];
  for (const line of rawOutput) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("{") || stripped.startsWith("["))
      continue;
    fallbackLines.push(stripped);
  }
  const fallback = fallbackLines.slice(-80).join("\n").trim();
  return fallback || "No normalized plan could be extracted from output.";
}
