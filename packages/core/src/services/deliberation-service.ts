/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, AgentInstance } from '../domain/agent/agent-config.js';
import { RunController, runAgentsParallel } from '../domain/agent/agent-executor.js';
import type { Stage1Result } from '../domain/council/stage-results.js';
import type { CouncilConfig } from '../domain/council/council-config.js';
import type { ImageAttachment } from '../domain/deliberation/deliberation.js';
import { runCouncilStages } from '../domain/deliberation/pipeline.js';
import type { ModelPerformanceSnapshot } from '../domain/run/run-metadata.js';
import type { RunRecord } from '../domain/run/run-record.js';
import type { DeliberationEvents } from '../ports/deliberation-events.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import type { LlmGateway } from '../ports/llm-gateway.js';
import type { RunRepository } from '../ports/run-repository.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('deliberation-service');

export interface DeliberationInput {
  runId?: string;
  prompt: string;
  images?: ImageAttachment[];
  agentInstances: AgentInstance[];
  cwd: string;
}

export interface DeliberationDeps {
  /** One headless CLI driver per agent provider id. */
  drivers: ReadonlyMap<string, HeadlessCliDriver>;
  llmGateway: LlmGateway;
  /** Resolved once by the caller (`ConfigService.resolve`); the service never re-reads config. */
  config: CouncilConfig;
  runRepository: RunRepository;
  events: DeliberationEvents;
}

export class DeliberationService {
  private activeControllers = new Map<string, RunController>();
  constructor(private deps: DeliberationDeps) {}

  async run(input: DeliberationInput): Promise<RunRecord> {
    const runId = input.runId ?? randomUUID();
    log.info(`run: starting ${runId}`);

    const controller = new RunController();
    this.activeControllers.set(runId, controller);
    const images = await materializeImages(input.images);

    try {
      const { config } = this.deps;
      const workingDir = input.cwd;

      // Build agent configs from instances. The name keys rankings and stats,
      // so repeated provider + model pairs get a "#n" suffix to stay distinct.
      const nameCounts = new Map<string, number>();
      const agentConfigs: AgentConfig[] = input.agentInstances
        .filter((inst) => inst.enabled)
        .map((inst) => {
          const modelParts = inst.model?.split('/') ?? [];
          const shortModel =
            modelParts.length > 1 ? modelParts.slice(1).join('/') : (inst.model ?? '');
          const baseName = shortModel ? `${inst.provider} · ${shortModel}` : inst.provider;
          const count = (nameCounts.get(baseName) ?? 0) + 1;
          nameCounts.set(baseName, count);
          return {
            id: inst.provider,
            instanceId: inst.instanceId,
            name: count > 1 ? `${baseName} #${count}` : baseName,
            enabled: true,
            model: inst.model || null,
            cwd: workingDir,
          };
        });

      // Stage 1: Run agents in parallel
      log.info('run: STAGE 1 - starting agent runs');
      this.deps.events.onStageChange(1, 'Competing — agents are generating responses');

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
        imagePaths: images.paths,
        callbacks: {
          onStatus: (agentKey, status) => {
            const name = agentKeyToName.get(agentKey) ?? agentKey;
            this.deps.events.onAgentStatus(agentKey, status, name);
          },
          onEvent: (agentKey, event) => this.deps.events.onAgentEvent(agentKey, event),
        },
        controller,
        drivers: this.deps.drivers,
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
      this.deps.events.onStageChange(2, 'Judging — peer review in progress');

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
            this.deps.events.onStageChange(3, 'Synthesizing — chairman producing final answer');
            this.deps.events.onSynthesisStart();
          },
        },
      });

      if (controller.isCancelled) {
        throw new Error('Run cancelled after Stage 2/3');
      }

      // Build model performance snapshots
      const modelSnapshots: Record<string, ModelPerformanceSnapshot> = {};
      for (const agent of agentResults) {
        if (agent.status !== 'success') continue;
        const latencyMs =
          agent.startedAt && agent.endedAt
            ? new Date(agent.endedAt).getTime() - new Date(agent.startedAt).getTime()
            : 0;
        modelSnapshots[agent.name] = {
          modelId: agent.name,
          provider: agent.id,
          // Agents run through local CLIs on the user's subscription, so API per-token prices don't apply.
          costPer1kTokens: null,
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
      await images.cleanup();
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

/** Agent CLIs read images from files, so inline (base64) attachments go to a temp dir that is removed after the run. */
async function materializeImages(images: ImageAttachment[] = []): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const paths = images.flatMap((img) => (img.path ? [img.path] : []));
  const inline = images.flatMap((img) => (!img.path && img.base64 ? [{ base64: img.base64, mimeType: img.mimeType }] : []));
  if (inline.length === 0) return { paths, cleanup: async () => {} };

  const dir = await mkdtemp(join(tmpdir(), 'concilium-images-'));
  for (const [i, img] of inline.entries()) {
    const extension = img.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
    const file = join(dir, `image-${i + 1}.${extension}`);
    await writeFile(file, Buffer.from(img.base64, 'base64'));
    paths.push(file);
  }
  return { paths, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
