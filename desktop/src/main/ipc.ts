/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { ipcMain, clipboard, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import type { AgentConfig, AgentInstance, StartRunConfig, Stage1Result } from './services/types';
import { 
  getCouncilConfig,
  getCouncilConfigSync,
  getCouncilConfigPrefs,
  saveCouncilConfigPrefs,
  encryptApiKey,
  listRuns,
  loadAllRuns,
  loadRun,
  saveRun,
  getLastOpencodeModel,
  saveLastOpencodeModel,
  getAgentInstances,
  saveAgentInstances
} from './services/storage';
import { fetchOpenRouterModels } from './services/openrouter';
import { RunController, runAgentsParallel, discoverModelsForAllAgents } from './services/runner';
import { runCouncilStages } from './services/pipeline';
import { createLogger } from './services/logger';

const log = createLogger('ipc');

const activeControllers = new Map<string, RunController>();

/** Kill every tracked child process. Called on app quit / signals. */
export function cancelAllRuns() {
  if (activeControllers.size === 0) return;
  log.info(`cancelAllRuns: killing ${activeControllers.size} active run(s)`);
  for (const [runId, controller] of activeControllers) {
    log.debug(`cancelAllRuns: cancelling run ${runId}`);
    controller.cancel();
  }
  activeControllers.clear();
}

export function registerIpcHandlers(mainWindow: BrowserWindow, projectCwd: string) {
  const send = (channel: string, ...args: unknown[]) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  };

  ipcMain.handle('config:get', async () => {
    const config = await getCouncilConfig();
    return {
      councilModels: config.councilModels,
      chairmanModel: config.chairmanModel,
      hasApiKey: !!config.openRouterApiKey,
      apiKeySetInEnv: !!process.env.OPENROUTER_API_KEY,
    };
  });

  ipcMain.handle('config:council:save', async (_, prefs: { chairmanModel?: string; councilModels?: string[]; apiKey?: string }) => {
    const config: { chairmanModel?: string; councilModels?: string[]; apiKeyEncrypted?: string } = {};
    
    if (prefs.chairmanModel) {
      config.chairmanModel = prefs.chairmanModel;
    }
    if (prefs.councilModels) {
      config.councilModels = prefs.councilModels;
    }
    if (prefs.apiKey) {
      config.apiKeyEncrypted = encryptApiKey(prefs.apiKey);
    }
    
    await saveCouncilConfigPrefs(config);
    return { success: true };
  });

  ipcMain.handle('openrouter:fetchModels', async (_, apiKey: string) => {
    const models = await fetchOpenRouterModels(apiKey);
    return models.map(m => ({
      id: m.id,
      name: m.name,
      description: m.description,
      context_length: m.context_length,
      pricing: m.pricing,
    }));
  });

  ipcMain.handle('app:getCwd', () => projectCwd);

  ipcMain.handle('storage:listRuns', () => listRuns());
  ipcMain.handle('storage:loadAllRuns', () => loadAllRuns());
  ipcMain.handle('storage:loadRun', (_, runId: string) => loadRun(runId));
  ipcMain.handle('clipboard:copy', (_, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle('models:discover', () => discoverModelsForAllAgents());
  ipcMain.handle('models:lastOpencode', () => getLastOpencodeModel());

  ipcMain.handle('agents:get', () => getAgentInstances());
  ipcMain.handle('agents:save', (_, instances: AgentInstance[]) => saveAgentInstances(instances));

  ipcMain.handle('run:start', async (_, params: StartRunConfig) => {
    log.info('run:start received', {
      prompt: params.prompt.slice(0, 100) + (params.prompt.length > 100 ? '...' : ''),
      agents: params.agents,
      agentInstances: params.agentInstances?.length ?? 0,
    });
    
    // Persist last-used opencode model
    const ocModel = params.agentModels?.opencode;
    if (ocModel) {
      saveLastOpencodeModel(ocModel).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`failed to persist last opencode model: ${message}`);
      });
    }

    const runId = randomUUID();
    log.debug(`run:start: created runId ${runId}`);
    
    const controller = new RunController();
    activeControllers.set(runId, controller);

    const config = await getCouncilConfig();
    log.debug('run:start: config loaded', {
      hasApiKey: !!config.openRouterApiKey,
      councilModels: config.councilModels,
      chairmanModel: config.chairmanModel,
    });
    
    const workingDir = projectCwd;

    // Build agent configs - prefer new agentInstances format, fallback to legacy
    let agentConfigs: AgentConfig[];
    if (params.agentInstances && params.agentInstances.length > 0) {
      // New format: use instanceId as unique identifier
      agentConfigs = params.agentInstances
        .filter((inst) => inst.enabled)
        .map((inst) => {
          // Extract short model name by removing first segment (e.g., "openrouter/openai/gpt-oss-120b" -> "openai/gpt-oss-120b")
          const modelParts = inst.model?.split('/') ?? [];
          const shortModel = modelParts.length > 1 ? modelParts.slice(1).join('/') : inst.model ?? '';
          return {
            id: inst.provider,
            instanceId: inst.instanceId,
            name: `${inst.provider} · ${shortModel}`,
            enabled: true,
            model: inst.model || null,
            cwd: workingDir,
          };
        });
    } else {
      // Legacy format: use provider as id
      agentConfigs = params.agents.map((id) => ({
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
        enabled: true,
        model: params.agentModels?.[id] ?? null,
        cwd: workingDir,
      }));
    }

    // Build initial agent info so the renderer can pre-populate state
    // before any streaming events arrive (avoids race condition where
    // agent:status events are sent before the renderer mounts listeners).
    const initialAgents = agentConfigs.map((cfg) => ({
      key: cfg.instanceId ?? cfg.id,
      name: cfg.name,
    }));

    // Run pipeline asynchronously — use setImmediate so the `return` below
    // delivers runId + initialAgents to the renderer BEFORE we start sending
    // streaming events.  Without this, webContents.send() calls are queued
    // ahead of the handle-response and the renderer misses every early event.
    setImmediate(async () => {
      log.debug(`run:start: starting async pipeline for runId ${runId}`);
      try {
        // Stage 1: Run agents in parallel
        log.info('run:start: STAGE 1 - starting agent runs');
        send('stage:change', 1, 'Competing — agents are generating responses');

        // Create a map of agentKey -> name for sending display names
        const agentKeyToName = new Map<string, string>();
        for (const cfg of agentConfigs) {
          const key = cfg.instanceId ?? cfg.id;
          agentKeyToName.set(key, cfg.name);
        }

        // Pre-register all agents with correct names so the renderer creates
        // state entries before any streaming events arrive (prevents UUID names)
        for (const cfg of agentConfigs) {
          const key = cfg.instanceId ?? cfg.id;
          send('agent:status', key, 'queued', cfg.name);
        }

        const agentResults = await runAgentsParallel({
          agents: agentConfigs,
          prompt: params.prompt,
          callbacks: {
            onStatus: (agentKey, status) => {
              const name = agentKeyToName.get(agentKey) ?? agentKey;
              send('agent:status', agentKey, status, name);
            },
            onEvent: (agentKey, event) => send('agent:event', agentKey, event),
          },
          controller,
        });

        if (controller.isCancelled) {
          log.warn('run:start: cancelled after Stage 1');
          return;
        }

        // Build Stage1Results from agent output (exclude aborted agents)
        const stage1Results: Stage1Result[] = agentResults
          .filter((r) => r.status === 'success' && r.normalizedPlan)
          .map((r) => ({ model: r.name, response: r.normalizedPlan }));

        const abortedCount = agentResults.filter((r) => r.status === 'aborted').length;
        log.info(`run:start: Stage 1 complete - ${stage1Results.length} successful, ${abortedCount} aborted, ${agentResults.length - stage1Results.length - abortedCount} failed`);

        for (const r of agentResults) {
          log.debug(`run:start: agent ${r.name}: status=${r.status}, plan length=${r.normalizedPlan?.length ?? 0}`);
        }

        // Check if we have any results to judge
        if (stage1Results.length === 0) {
          log.warn('run:start: no successful agent results to judge');
          send('run:error', 'All agents failed or were aborted. No responses to judge.');
          return;
        }

        // Stage 2 & 3: Council ranking and synthesis
        log.info('run:start: STAGE 2 - starting council ranking');
        send('stage:change', 2, 'Judging — peer review in progress');

        const [stage2Results, stage3Result, metadata] = await runCouncilStages({
          config,
          userPrompt: params.prompt,
          stage1Results,
          callbacks: {
            onRankingModelStart: (model) => send('juror:status', model, 'evaluating'),
            onRankingModelChunk: (model, chunk) => send('juror:chunk', model, chunk),
            onRankingModelComplete: (model, success, usage) => {
              send('juror:status', model, success ? 'complete' : 'failed');
              if (usage) {
                send('juror:usage', model, usage);
              }
            },
            onSynthesisStart: () => send('stage:change', 3, 'Synthesizing — chairman producing final answer'),
          },
        });

        if (controller.isCancelled) {
          log.warn('run:start: cancelled after Stage 2/3');
          return;
        }

        log.info('run:start: all stages complete, saving run record');
        const record = {
          id: runId,
          createdAt: new Date().toISOString(),
          prompt: params.prompt,
          cwd: workingDir,
          selectedAgents: params.agents,
          agents: agentResults,
          stage1: stage1Results,
          stage2: stage2Results,
          stage3: stage3Result,
          metadata,
        };

        await saveRun(record);
        log.info(`run:start: run ${runId} saved successfully`);
        send('run:complete', record);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        log.error(`run:start: pipeline error for ${runId}:`, err);
        send('run:error', message);
      } finally {
        log.debug(`run:start: cleanup for ${runId}`);
        activeControllers.delete(runId);
      }
    });

    return { runId, initialAgents };
  });

  ipcMain.handle('run:cancel', (_, runId: string) => {
    const controller = activeControllers.get(runId);
    controller?.cancel();
    activeControllers.delete(runId);
  });

  ipcMain.handle('agent:abort', (_, runId: string, agentKey: string) => {
    const controller = activeControllers.get(runId);
    if (controller?.cancelAgent(agentKey)) {
      log.info(`agent:abort: aborted agent ${agentKey} in run ${runId}`);
      return { success: true };
    }
    return { success: false, error: 'Agent not found or not running' };
  });
}
