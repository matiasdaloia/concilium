/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface AgentModelInfo {
  id: string;
  models: string[];
  defaultModel: string;
  supportsDiscovery: boolean;
}

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: number;
    completion: number;
  };
}

export interface CouncilConfig {
  councilModels: string[];
  chairmanModel: string;
  hasApiKey: boolean;
  apiKeySetInEnv: boolean;
}

export type AgentProvider = 'opencode' | 'codex' | 'claude';

export interface AgentInstance {
  instanceId: string;
  provider: AgentProvider;
  model: string;
  enabled: boolean;
}

export interface StartRunResult {
  runId: string;
  initialAgents: Array<{ key: string; name: string }>;
}

export interface UserRanking {
  rankedModelIds: string[];
  timestamp: string;
}

export interface ElectronAPI {
  startRun(config: { prompt: string; agents: string[]; mode?: string; agentModels?: Record<string, string>; agentInstances?: AgentInstance[] }): Promise<StartRunResult>;
  cancelRun(runId: string): Promise<void>;
  abortAgent(runId: string, agentKey: string): Promise<{ success: boolean; error?: string }>;
  listRuns(): Promise<Array<{ id: string; createdAt: string; promptPreview: string; status: string }>>;
  loadAllRuns(): Promise<unknown[]>;
  loadRun(runId: string): Promise<unknown>;
  getConfig(): Promise<CouncilConfig>;
  discoverModels(): Promise<AgentModelInfo[]>;
  getLastOpencodeModel(): Promise<string | undefined>;
  copyToClipboard(text: string): Promise<void>;
  saveUserFeedback(runId: string, ranking: UserRanking): Promise<{ success: boolean }>;

  // Agent instances (dynamic configuration)
  getAgentInstances(): Promise<AgentInstance[]>;
  saveAgentInstances(instances: AgentInstance[]): Promise<void>;

  // Project working directory
  getCwd(): Promise<string>;

  // Council configuration
  saveCouncilConfig(config: { chairmanModel?: string; councilModels?: string[]; apiKey?: string }): Promise<{ success: boolean }>;
  fetchOpenRouterModels(apiKey: string): Promise<OpenRouterModelInfo[]>;

  onAgentStatus(cb: (agentId: string, status: string, name?: string) => void): () => void;
  onAgentEvent(cb: (agentId: string, event: unknown) => void): () => void;
  onStageChange(cb: (stage: number, summary: string) => void): () => void;
  onJurorStatus(cb: (model: string, status: string) => void): () => void;
  onJurorChunk(cb: (model: string, chunk: string) => void): () => void;
  onJurorUsage(cb: (model: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void): () => void;
  onRunComplete(cb: (record: unknown) => void): () => void;
  onRunError(cb: (error: string) => void): () => void;
}

const api: ElectronAPI = {
  startRun: (config) => ipcRenderer.invoke('run:start', config),
  cancelRun: (runId) => ipcRenderer.invoke('run:cancel', runId),
  abortAgent: (runId, agentKey) => ipcRenderer.invoke('agent:abort', runId, agentKey),
  listRuns: () => ipcRenderer.invoke('storage:listRuns'),
  loadAllRuns: () => ipcRenderer.invoke('storage:loadAllRuns'),
  loadRun: (runId) => ipcRenderer.invoke('storage:loadRun', runId),
  getConfig: () => ipcRenderer.invoke('config:get'),
  discoverModels: () => ipcRenderer.invoke('models:discover'),
  getLastOpencodeModel: () => ipcRenderer.invoke('models:lastOpencode'),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:copy', text),
  saveUserFeedback: (runId, ranking) => ipcRenderer.invoke('run:saveUserFeedback', runId, ranking),

  // Project working directory
  getCwd: () => ipcRenderer.invoke('app:getCwd'),

  // Agent instances (dynamic configuration)
  getAgentInstances: () => ipcRenderer.invoke('agents:get'),
  saveAgentInstances: (instances) => ipcRenderer.invoke('agents:save', instances),
  
  // Council configuration
  saveCouncilConfig: (config) => ipcRenderer.invoke('config:council:save', config),
  fetchOpenRouterModels: (apiKey) => ipcRenderer.invoke('openrouter:fetchModels', apiKey),

  onAgentStatus: (cb) => {
    const handler = (_: unknown, agentId: string, status: string, name?: string) => cb(agentId, status, name);
    ipcRenderer.on('agent:status', handler);
    return () => ipcRenderer.removeListener('agent:status', handler);
  },
  onAgentEvent: (cb) => {
    const handler = (_: unknown, agentId: string, event: unknown) => cb(agentId, event);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  onStageChange: (cb) => {
    const handler = (_: unknown, stage: number, summary: string) => cb(stage, summary);
    ipcRenderer.on('stage:change', handler);
    return () => ipcRenderer.removeListener('stage:change', handler);
  },
  onJurorStatus: (cb) => {
    const handler = (_: unknown, model: string, status: string) => cb(model, status);
    ipcRenderer.on('juror:status', handler);
    return () => ipcRenderer.removeListener('juror:status', handler);
  },
  onJurorChunk: (cb) => {
    const handler = (_: unknown, model: string, chunk: string) => cb(model, chunk);
    ipcRenderer.on('juror:chunk', handler);
    return () => ipcRenderer.removeListener('juror:chunk', handler);
  },
  onJurorUsage: (cb) => {
    const handler = (_: unknown, model: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => cb(model, usage);
    ipcRenderer.on('juror:usage', handler);
    return () => ipcRenderer.removeListener('juror:usage', handler);
  },
  onRunComplete: (cb) => {
    const handler = (_: unknown, record: unknown) => cb(record);
    ipcRenderer.on('run:complete', handler);
    return () => ipcRenderer.removeListener('run:complete', handler);
  },
  onRunError: (cb) => {
    const handler = (_: unknown, error: string) => cb(error);
    ipcRenderer.on('run:error', handler);
    return () => ipcRenderer.removeListener('run:error', handler);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
