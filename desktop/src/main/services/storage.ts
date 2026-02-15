import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentInstance, CouncilConfig, RunRecord } from "./types";

// ============================================================================
// Council Configuration Persistence
// ============================================================================

export interface CouncilConfigPrefs {
  chairmanModel?: string;
  councilModels?: string[];
  apiKeyEncrypted?: string; // base64 encrypted with safeStorage
}

/**
 * Encrypt API key using OS-native keychain
 */
export function encryptApiKey(apiKey: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback to base64 if encryption not available (development)
    return Buffer.from(apiKey).toString("base64");
  }
  const encrypted = safeStorage.encryptString(apiKey);
  return encrypted.toString("base64");
}

/**
 * Decrypt API key from storage
 */
export function decryptApiKey(encryptedKey: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback to base64 if encryption not available (development)
    return Buffer.from(encryptedKey, "base64").toString("utf-8");
  }
  const buffer = Buffer.from(encryptedKey, "base64");
  return safeStorage.decryptString(buffer);
}

const DEFAULT_COUNCIL_MODELS = [
  "openai/gpt-5.2",
  "google/gemini-3-pro-preview",
  "anthropic/claude-opus-4.6",
];
const DEFAULT_CHAIRMAN_MODEL = "google/gemini-3-pro-preview";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

function getRunsDir(): string {
  return join(app.getPath("userData"), "runs");
}

function getPrefsPath(): string {
  return join(app.getPath("userData"), "preferences.json");
}

async function ensureRunsDir(): Promise<string> {
  const dir = getRunsDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveRun(run: RunRecord): Promise<string> {
  const dir = await ensureRunsDir();
  const filePath = join(dir, `${run.id}.json`);
  // Use compact JSON (no indentation) to reduce file size — run files with
  // full event streams can be several MB; pretty-printing roughly doubles that.
  await writeFile(filePath, JSON.stringify(run), "utf-8");
  return filePath;
}

export async function loadRun(runId: string): Promise<RunRecord> {
  const dir = await ensureRunsDir();
  const filePath = join(dir, `${runId}.json`);
  const data = await readFile(filePath, "utf-8");
  return JSON.parse(data);
}

export async function loadAllRuns(): Promise<RunRecord[]> {
  const dir = await ensureRunsDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }

  // Read files in parallel for faster loading
  const BATCH_SIZE = 20;
  const records: RunRecord[] = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const data: RunRecord = JSON.parse(
          await readFile(join(dir, file), "utf-8"),
        );
        // Strip rawOutput and events for memory efficiency — analytics only
        // needs token usage (extracted from events) and timing, not the full
        // event stream which can be thousands of entries per agent.
        return {
          ...data,
          agents: data.agents.map(agent => {
            const { rawOutput: _raw, events, ...rest } = agent;
            // Extract final token usage from events before discarding them
            const usage = extractFinalTokenUsage(events);
            return {
              ...rest,
              rawOutput: undefined,
              events: usage ? [usage] : [],
            } as typeof agent;
          }),
        };
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        records.push(result.value);
      }
    }
  }

  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return records;
}

/**
 * Extract a single synthetic event containing the final token usage
 * from an events array. This allows us to discard the full event stream
 * while preserving the data analytics needs.
 */
function extractFinalTokenUsage(events: RunRecord["agents"][0]["events"]): RunRecord["agents"][0]["events"][0] | null {
  if (!events || events.length === 0) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost: number | null = null;

  for (const ev of events) {
    if (!ev.tokenUsage) continue;
    if (ev.tokenUsageCumulative) {
      inputTokens = ev.tokenUsage.inputTokens;
      outputTokens = ev.tokenUsage.outputTokens;
      totalCost = ev.tokenUsage.totalCost ?? null;
    } else {
      inputTokens += ev.tokenUsage.inputTokens;
      outputTokens += ev.tokenUsage.outputTokens;
      const prevCost: number = totalCost ?? 0;
      const evtCost: number = ev.tokenUsage.totalCost ?? 0;
      totalCost = (prevCost + evtCost) > 0 ? prevCost + evtCost : null;
    }
  }

  if (inputTokens === 0 && outputTokens === 0 && totalCost === null) return null;

  return {
    eventType: "status",
    text: "",
    rawLine: "",
    tokenUsage: { inputTokens, outputTokens, totalCost },
    tokenUsageCumulative: true,
  };
}

export async function listRuns(): Promise<
  Array<{
    id: string;
    createdAt: string;
    promptPreview: string;
    status: string;
  }>
> {
  const dir = await ensureRunsDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }

  const records: Array<{
    id: string;
    createdAt: string;
    promptPreview: string;
    status: string;
  }> = [];

  for (const file of files) {
    try {
      const data: RunRecord = JSON.parse(
        await readFile(join(dir, file), "utf-8"),
      );
      let status: string;
      if (data.agents.every((a) => a.status === "success")) {
        status = "success";
      } else if (data.agents.some((a) => a.status === "running")) {
        status = "running";
      } else if (data.agents.some((a) => a.status === "error")) {
        status = "partial_error";
      } else {
        status = "mixed";
      }
      records.push({
        id: data.id,
        createdAt: data.createdAt,
        promptPreview: data.prompt.slice(0, 70),
        status,
      });
    } catch {
      continue;
    }
  }

  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return records;
}

interface Preferences {
  lastOpencodeModel?: string;
  agentInstances?: AgentInstance[];
  councilConfig?: CouncilConfigPrefs;
  [key: string]: unknown;
}

async function readPrefs(): Promise<Preferences> {
  try {
    const data = await readFile(getPrefsPath(), "utf-8");
    const parsed = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function writePrefs(prefs: Preferences): Promise<void> {
  const dir = app.getPath("userData");
  await mkdir(dir, { recursive: true });
  await writeFile(getPrefsPath(), JSON.stringify(prefs, null, 2), "utf-8");
}

export async function getLastOpencodeModel(): Promise<string | undefined> {
  const prefs = await readPrefs();
  return prefs.lastOpencodeModel;
}

export async function saveLastOpencodeModel(model: string): Promise<void> {
  const prefs = await readPrefs();
  prefs.lastOpencodeModel = model;
  await writePrefs(prefs);
}

/**
 * Get council configuration from preferences
 */
export async function getCouncilConfigPrefs(): Promise<CouncilConfigPrefs> {
  const prefs = await readPrefs();
  return prefs.councilConfig ?? {};
}

/**
 * Save council configuration to preferences
 */
export async function saveCouncilConfigPrefs(config: CouncilConfigPrefs): Promise<void> {
  const prefs = await readPrefs();
  prefs.councilConfig = config;
  await writePrefs(prefs);
}

/**
 * Get the effective council configuration
 * Priority: Environment variables > User preferences > Defaults
 */
export async function getCouncilConfig(): Promise<CouncilConfig> {
  // Check environment variables first
  const envApiKey = process.env.OPENROUTER_API_KEY ?? "";
  const envCouncilModels = process.env.COUNCIL_MODELS ?? "";
  const envChairmanModel = process.env.CHAIRMAN_MODEL ?? "";
  const envApiUrl = process.env.OPENROUTER_API_URL ?? "";

  // Get user preferences
  const prefs = await getCouncilConfigPrefs();

  // Decrypt API key from preferences if exists and no env var
  let prefApiKey = "";
  if (prefs.apiKeyEncrypted && !envApiKey) {
    try {
      prefApiKey = decryptApiKey(prefs.apiKeyEncrypted);
    } catch {
      // Ignore decryption errors
      prefApiKey = "";
    }
  }

  // Parse council models from preferences
  const prefCouncilModels = prefs.councilModels ?? [];

  // Determine final values (env takes precedence)
  const apiKey = envApiKey || prefApiKey;
  const apiUrl = envApiUrl || OPENROUTER_API_URL;

  // Parse council models from env or use preferences/defaults
  let councilModels: string[];
  if (envCouncilModels) {
    councilModels = envCouncilModels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (prefCouncilModels.length > 0) {
    councilModels = prefCouncilModels;
  } else {
    councilModels = DEFAULT_COUNCIL_MODELS;
  }

  // Determine chairman model
  const chairmanModel = envChairmanModel || prefs.chairmanModel || DEFAULT_CHAIRMAN_MODEL;

  return {
    openRouterApiKey: apiKey,
    openRouterApiUrl: apiUrl,
    councilModels: councilModels.length > 0 ? councilModels : DEFAULT_COUNCIL_MODELS,
    chairmanModel,
  };
}

/**
 * Get council configuration synchronously (for backward compatibility)
 * Note: This does not include preferences since we need to read from disk
 */
export function getCouncilConfigSync(): CouncilConfig {
  const councilModelsRaw = process.env.COUNCIL_MODELS ?? "";
  const councilModels = councilModelsRaw
    ? councilModelsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_COUNCIL_MODELS;

  return {
    openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    openRouterApiUrl: process.env.OPENROUTER_API_URL ?? OPENROUTER_API_URL,
    councilModels:
      councilModels.length > 0 ? councilModels : DEFAULT_COUNCIL_MODELS,
    chairmanModel: process.env.CHAIRMAN_MODEL ?? DEFAULT_CHAIRMAN_MODEL,
  };
}

function createDefaultAgentInstances(): AgentInstance[] {
  return [
    {
      instanceId: randomUUID(),
      provider: "opencode",
      model: "", // Will be filled by discovery
      enabled: true,
    },
    {
      instanceId: randomUUID(),
      provider: "opencode",
      model: "", // Will be filled by discovery
      enabled: true,
    },
  ];
}

function isValidAgentInstance(obj: unknown): obj is AgentInstance {
  if (typeof obj !== "object" || obj === null) return false;
  const instance = obj as Record<string, unknown>;
  return (
    typeof instance.instanceId === "string" &&
    typeof instance.provider === "string" &&
    ["opencode", "codex", "claude"].includes(instance.provider) &&
    typeof instance.model === "string" &&
    typeof instance.enabled === "boolean"
  );
}

export async function getAgentInstances(): Promise<AgentInstance[]> {
  const prefs = await readPrefs();

  // Validate the stored instances
  if (Array.isArray(prefs.agentInstances) && prefs.agentInstances.length > 0) {
    const validInstances = prefs.agentInstances.filter(isValidAgentInstance);
    if (validInstances.length >= 2) {
      return validInstances;
    }
  }

  // Return defaults if no valid instances found
  return createDefaultAgentInstances();
}

export async function saveAgentInstances(
  instances: AgentInstance[],
): Promise<void> {
  const prefs = await readPrefs();
  prefs.agentInstances = instances;
  await writePrefs(prefs);
}
