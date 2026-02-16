/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { app, clipboard, dialog, ipcMain, type BrowserWindow } from "electron";
import {
  createLogger,
  DeliberationService,
  OpenRouterGateway,
  ClaudeProvider,
  CodexProvider,
  OpenCodeProvider,
  JsonRunRepository,
  JsonConfigStore,
  ConfigService,
  ModelDiscoveryService,
  shutdownEmbeddedServer,
  type AgentInstance,
  type AgentProvider,
  type StartRunConfig,
  type UserRanking,
} from "@concilium/core";
import { ElectronSecretStore } from "./adapters/electron-secret-store";
import { ElectronEventBridge } from "./adapters/electron-event-bridge";

const log = createLogger("ipc");

let deliberationService: DeliberationService | null = null;

/** Kill every tracked child process. Called on app quit / signals. */
export function cancelAllRuns() {
  deliberationService?.cancelAll();
  shutdownEmbeddedServer();
}

function buildProviders(): Map<string, AgentProvider> {
  const providers = new Map<string, AgentProvider>();
  providers.set("claude", new ClaudeProvider());
  providers.set("codex", new CodexProvider());
  providers.set("opencode", new OpenCodeProvider());
  return providers;
}

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  initialCwd: string,
) {
  let projectCwd = initialCwd;
  // Core dependencies
  const dataDir = app.getPath("userData");
  const secretStore = new ElectronSecretStore();
  const configStore = new JsonConfigStore(dataDir);
  const configService = new ConfigService(configStore, secretStore);
  const runRepository = new JsonRunRepository(dataDir);
  const providers = buildProviders();
  const modelDiscovery = new ModelDiscoveryService(providers);

  // Config handlers
  ipcMain.handle("config:get", async () => {
    const config = await configService.resolve();
    return {
      councilModels: config.councilModels,
      chairmanModel: config.chairmanModel,
      hasApiKey: !!config.openRouterApiKey,
      apiKeySetInEnv: !!process.env.OPENROUTER_API_KEY,
    };
  });

  ipcMain.handle(
    "config:council:save",
    async (
      _,
      prefs: {
        chairmanModel?: string;
        councilModels?: string[];
        apiKey?: string;
      },
    ) => {
      await configService.saveCouncilConfig(prefs);
      return { success: true };
    },
  );

  ipcMain.handle("openrouter:fetchModels", async (_, apiKey: string) => {
    const gateway = new OpenRouterGateway(apiKey, "https://openrouter.ai/api/v1/chat/completions");
    const models = await gateway.fetchModels();
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      context_length: m.context_length,
      pricing: m.pricing,
    }));
  });

  ipcMain.handle("app:getCwd", () => projectCwd);

  ipcMain.handle("app:selectCwd", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      defaultPath: projectCwd,
      title: "Select working directory",
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    projectCwd = result.filePaths[0];
    return projectCwd;
  });

  // Storage handlers
  ipcMain.handle("storage:listRuns", () => runRepository.list());
  ipcMain.handle("storage:loadAllRuns", () => runRepository.loadAll());
  ipcMain.handle("storage:loadRun", (_, runId: string) => runRepository.load(runId));
  ipcMain.handle("clipboard:copy", (_, text: string) => {
    clipboard.writeText(text);
  });

  // Model discovery
  ipcMain.handle("models:discover", () => modelDiscovery.discoverAll());
  ipcMain.handle("models:lastOpencode", () => configStore.getLastOpencodeModel());

  // Agent management
  ipcMain.handle("agents:get", () => configStore.getAgentInstances());
  ipcMain.handle("agents:save", (_, instances: AgentInstance[]) =>
    configStore.saveAgentInstances(instances),
  );

  // Run execution — delegates to DeliberationService
  ipcMain.handle("run:start", async (_, params: StartRunConfig) => {
    log.info("run:start received", {
      prompt: params.prompt.slice(0, 100) + (params.prompt.length > 100 ? "..." : ""),
      images: params.images?.length ?? 0,
      agents: params.agents,
      agentInstances: params.agentInstances?.length ?? 0,
    });

    // Persist last-used opencode model
    const ocModel = params.agentModels?.opencode;
    if (ocModel) {
      configStore.saveLastOpencodeModel(ocModel).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`failed to persist last opencode model: ${message}`);
      });
    }

    // Build agent instances (prefer new format, fallback to legacy)
    const agentInstances: AgentInstance[] =
      params.agentInstances && params.agentInstances.length > 0
        ? params.agentInstances.filter((inst) => inst.enabled)
        : params.agents.map((id) => ({
            instanceId: crypto.randomUUID(),
            provider: id,
            model: params.agentModels?.[id] ?? "",
            enabled: true,
          }));

    // Build initial agent info for the renderer
    const initialAgents = agentInstances.map((inst) => {
      const modelParts = inst.model?.split("/") ?? [];
      const shortModel = modelParts.length > 1 ? modelParts.slice(1).join("/") : (inst.model ?? "");
      return {
        key: inst.instanceId,
        name: `${inst.provider} \u00B7 ${shortModel}`,
      };
    });

    // Resolve config to get API key for the gateway
    const config = await configService.resolve();
    const llmGateway = new OpenRouterGateway(config.openRouterApiKey, config.openRouterApiUrl);
    const events = new ElectronEventBridge(mainWindow);

    deliberationService = new DeliberationService({
      providers,
      llmGateway,
      configStore,
      secretStore,
      runRepository,
      events,
    });

    // Run pipeline asynchronously
    const runId = crypto.randomUUID();
    setImmediate(async () => {
      try {
        await deliberationService!.run({
          runId,
          prompt: params.prompt,
          images: params.images,
          agentInstances,
          cwd: projectCwd,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error(`run:start: pipeline error:`, err);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send("run:error", message);
        }
      }
    });

    return { runId, initialAgents };
  });

  ipcMain.handle("run:cancel", (_, runId: string) => {
    deliberationService?.cancel(runId);
  });

  ipcMain.handle("agent:abort", (_, runId: string, agentKey: string) => {
    if (deliberationService?.cancelAgent(runId, agentKey)) {
      log.info(`agent:abort: aborted agent ${agentKey} in run ${runId}`);
      return { success: true };
    }
    return { success: false, error: "Agent not found or not running" };
  });

  ipcMain.handle(
    "run:saveUserFeedback",
    async (_, runId: string, ranking: UserRanking) => {
      const run = await runRepository.load(runId);
      if (!run) throw new Error("Run not found");
      run.metadata.userFeedback = ranking;
      await runRepository.save(run);
      return { success: true };
    },
  );

  // Voice transcription using nodejs-whisper (stays in desktop, not moved to core)
  ipcMain.handle(
    "voice:transcribe",
    async (_, audioData: { buffer: ArrayBuffer; mimeType: string }) => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");

      try {
        log.info("voice:transcribe: received audio data", {
          size: audioData.buffer.byteLength,
          mimeType: audioData.mimeType,
        });

        const tempDir = await fs.promises.mkdtemp(
          path.join(os.tmpdir(), "concilium-voice-"),
        );
        const inputPath = path.join(tempDir, "input.webm");
        const outputPath = path.join(tempDir, "output.wav");

        await fs.promises.writeFile(inputPath, Buffer.from(audioData.buffer));

        try {
          const { execSync } = await import("node:child_process");
          execSync(
            `ffmpeg -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}" -y`,
            { stdio: "pipe" },
          );
        } catch {
          await fs.promises.copyFile(inputPath, outputPath);
        }

        const { nodewhisper } = await import("nodejs-whisper");

        const result = await nodewhisper(outputPath, {
          modelName: "base.en",
          removeWavFileAfterTranscription: false,
          logger: {
            error: (msg: string) => log.error("[Whisper]", msg),
            log: (msg: string) => log.debug("[Whisper]", msg),
            debug: (msg: string) => log.debug("[Whisper]", msg),
          },
          whisperOptions: {
            outputInText: true,
            outputInSrt: false,
            outputInVtt: false,
            outputInJson: false,
            outputInCsv: false,
            outputInLrc: false,
            outputInWords: false,
            translateToEnglish: false,
            wordTimestamps: false,
            timestamps_length: 20,
            splitOnWord: false,
          },
        });

        try {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }

        let transcript = "";
        if (typeof result === "string") {
          transcript = result;
        } else if (result && typeof result === "object") {
          transcript =
            (result as { text?: string }).text ||
            (result as { transcript?: string }).transcript ||
            JSON.stringify(result);
        }

        const cleanedTranscript = transcript
          .split("\n")
          .map((line) =>
            line.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/g, "").trim(),
          )
          .filter((line) => line.length > 0)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        return { success: true, transcript: cleanedTranscript };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        log.error("voice:transcribe: transcription failed", err);
        return { success: false, error: message };
      }
    },
  );
}
