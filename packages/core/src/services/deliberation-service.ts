import { randomUUID } from 'node:crypto';
import type { AgentConfig, AgentInstance } from '../domain/agent/agent-config.js';
import { RunController, runAgentsParallel, type AgentModelInfo } from '../domain/agent/agent-executor.js';
import type { AgentResult } from '../domain/agent/agent-result.js';
import type { Stage1Result } from '../domain/council/stage-results.js';
import type { CouncilConfig } from '../domain/council/council-config.js';
import type { ImageAttachment } from '../domain/deliberation/deliberation.js';
import { runCouncilStages } from '../domain/deliberation/pipeline.js';
import type { ModelPerformanceSnapshot } from '../domain/run/run-metadata.js';
import type { RunRecord } from '../domain/run/run-record.js';
import type { AgentProvider } from '../ports/agent-provider.js';
import type { ConfigStore } from '../ports/config-store.js';
import type { DeliberationEvents } from '../ports/deliberation-events.js';
import type { LlmGateway } from '../ports/llm-gateway.js';
import type { RunRepository } from '../ports/run-repository.js';
import type { SecretStore } from '../ports/secret-store.js';
import { ConfigService } from './config-service.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('deliberation-service');

export interface DeliberationInput {
  prompt: string;
  images?: ImageAttachment[];
  agentInstances: AgentInstance[];
  cwd: string;
}

export interface DeliberationDeps {
  providers: Map<string, AgentProvider>;
  llmGateway: LlmGateway;
  configStore: ConfigStore;
  secretStore: SecretStore;
  runRepository: RunRepository;
  events: DeliberationEvents;
}

export class DeliberationService {
  private activeControllers = new Map<string, RunController>();
  private configService: ConfigService;

  constructor(private deps: DeliberationDeps) {
    this.configService = new ConfigService(deps.configStore, deps.secretStore);
  }

  async run(input: DeliberationInput): Promise<RunRecord> {
    const runId = randomUUID();
    log.info(`run: starting ${runId}`);

    const controller = new RunController();
    this.activeControllers.set(runId, controller);

    try {
      const config = await this.configService.resolve();
      const workingDir = input.cwd;

      // Build agent configs from instances
      const agentConfigs: AgentConfig[] = input.agentInstances
        .filter((inst) => inst.enabled)
        .map((inst) => {
          const modelParts = inst.model?.split('/') ?? [];
          const shortModel =
            modelParts.length > 1 ? modelParts.slice(1).join('/') : (inst.model ?? '');
          return {
            id: inst.provider,
            instanceId: inst.instanceId,
            name: `${inst.provider} \u00B7 ${shortModel}`,
            enabled: true,
            model: inst.model || null,
            cwd: workingDir,
          };
        });

      // Stage 1: Run agents in parallel
      log.info('run: STAGE 1 - starting agent runs');
      this.deps.events.onStageChange(1, 'Competing \u2014 agents are generating responses');

      // Pre-register all agents
      const agentKeyToName = new Map<string, string>();
      for (const cfg of agentConfigs) {
        const key = cfg.instanceId ?? cfg.id;
        agentKeyToName.set(key, cfg.name);
        this.deps.events.onAgentStatus(key, 'queued', cfg.name);
      }

      const agentResults = await runAgentsParallel({
        agents: agentConfigs,
        prompt: input.prompt,
        images: input.images,
        callbacks: {
          onStatus: (agentKey, status) => {
            const name = agentKeyToName.get(agentKey) ?? agentKey;
            this.deps.events.onAgentStatus(agentKey, status, name);
          },
          onEvent: (agentKey, event) => this.deps.events.onAgentEvent(agentKey, event),
        },
        controller,
        providers: this.deps.providers,
      });

      if (controller.isCancelled) {
        throw new Error('Run cancelled after Stage 1');
      }

      // Build Stage1Results
      const stage1Results: Stage1Result[] = agentResults
        .filter((r) => r.status === 'success' && r.normalizedPlan)
        .map((r) => ({ model: r.name, response: r.normalizedPlan }));

      if (stage1Results.length === 0) {
        const errorMsg = 'All agents failed or were aborted. No responses to judge.';
        this.deps.events.onError(errorMsg);
        throw new Error(errorMsg);
      }

      // Stage 2 & 3: Council ranking and synthesis
      log.info('run: STAGE 2 - starting council ranking');
      this.deps.events.onStageChange(2, 'Judging \u2014 peer review in progress');

      const [stage2Results, stage3Result, metadata] = await runCouncilStages({
        config,
        userPrompt: input.prompt,
        stage1Results,
        llmGateway: this.deps.llmGateway,
        callbacks: {
          onRankingModelStart: (model) => this.deps.events.onJurorStatus(model, 'evaluating'),
          onRankingModelChunk: (model, chunk) => this.deps.events.onJurorChunk(model, chunk),
          onRankingModelComplete: (model, success, usage) => {
            this.deps.events.onJurorComplete(model, success, usage);
          },
          onSynthesisStart: () => {
            this.deps.events.onStageChange(3, 'Synthesizing \u2014 chairman producing final answer');
            this.deps.events.onSynthesisStart();
          },
        },
      });

      if (controller.isCancelled) {
        throw new Error('Run cancelled after Stage 2/3');
      }

      // Build model performance snapshots
      const modelSnapshots: Record<string, ModelPerformanceSnapshot> = {};
      const cachedModels = this.deps.llmGateway.getCachedOrFallbackModels();
      const agentKeyToModel = new Map<string, string>();
      for (const cfg of agentConfigs) {
        const key = cfg.instanceId ?? cfg.id;
        if (cfg.model) agentKeyToModel.set(key, cfg.model);
      }
      for (const agent of agentResults) {
        if (agent.status !== 'success') continue;
        const latencyMs =
          agent.startedAt && agent.endedAt
            ? new Date(agent.endedAt).getTime() - new Date(agent.startedAt).getTime()
            : 0;
        const agentKey = agent.agentKey ?? agent.id;
        const fullModelId = agentKeyToModel.get(agentKey) ?? '';
        const modelInfo = cachedModels.find(
          (m) => m.id === fullModelId || fullModelId.endsWith(m.id) || m.id.endsWith(fullModelId),
        );
        const costPer1k = modelInfo
          ? (modelInfo.pricing.prompt + modelInfo.pricing.completion) / 2 / 1000
          : 0;
        modelSnapshots[agent.name] = {
          modelId: agent.name,
          provider: agent.id,
          costPer1kTokens: costPer1k,
          latencyMs,
          speedTier: latencyMs < 15000 ? 'fast' : latencyMs < 60000 ? 'balanced' : 'slow',
        };
      }
      metadata.modelSnapshots = modelSnapshots;

      const selectedAgents = agentConfigs.map((c) => c.id);

      const record: RunRecord = {
        id: runId,
        createdAt: new Date().toISOString(),
        prompt: input.prompt,
        cwd: workingDir,
        selectedAgents,
        agents: agentResults,
        stage1: stage1Results,
        stage2: stage2Results,
        stage3: stage3Result,
        metadata,
      };

      await this.deps.runRepository.save(record);
      log.info(`run: run ${runId} saved successfully`);
      this.deps.events.onComplete(record);

      return record;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.error(`run: pipeline error for ${runId}:`, err);
      this.deps.events.onError(message);
      throw err;
    } finally {
      this.activeControllers.delete(runId);
    }
  }

  cancel(runId: string): void {
    const controller = this.activeControllers.get(runId);
    controller?.cancel();
    this.activeControllers.delete(runId);
  }

  cancelAgent(runId: string, agentKey: string): boolean {
    const controller = this.activeControllers.get(runId);
    return controller?.cancelAgent(agentKey) ?? false;
  }

  cancelAll(): void {
    for (const [, controller] of this.activeControllers) {
      controller.cancel();
    }
    this.activeControllers.clear();
  }
}
