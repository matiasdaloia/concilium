/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstance, AgentProviderType } from '../domain/agent/agent-config.js';
import type { OpenRouterModelInfo } from '../domain/council/model-info.js';
import type { RunRecord } from '../domain/run/run-record.js';
import type { DeliberationEvents } from '../ports/deliberation-events.js';
import type { LlmGateway, LlmResponse } from '../ports/llm-gateway.js';
import { FakeCliDriver } from '../adapters/cli/fake-cli-driver.js';
import { JsonConfigStore } from '../adapters/json-config-store.js';
import { JsonRunRepository } from '../adapters/json-run-repository.js';
import { PlaintextSecretStore } from '../adapters/plaintext-secret-store.js';
import { setLogLevel } from '../shared/logger.js';
import { ConfigService } from './config-service.js';
import { DeliberationService } from './deliberation-service.js';

const PROMPT = 'Add rate limiting to the API';
const PLANS: Record<string, string> = {
  claude: 'Plan: token bucket in middleware',
  codex: 'Plan: sliding window in Redis',
};
const JURORS = ['fake/juror-1', 'fake/juror-2'];
const CHAIRMAN = 'fake/chairman';
const SYNTHESIS = 'Final plan: sliding window in Redis, with middleware fallback';

/** A driver that streams a fixed plan, or fails, without spawning anything. */
function planDriver(id: string, plan: string | Error): FakeCliDriver {
  return new FakeCliDriver({
    id,
    events: plan instanceof Error ? [{ type: 'error', message: plan.message }] : [{ type: 'text', text: plan }],
  });
}

/**
 * Jurors rank whichever anonymized response contains `preferred` first.
 * The chairman answers with SYNTHESIS.
 */
class FakeLlmGateway implements LlmGateway {
  constructor(
    private readonly preferred: string,
    private readonly pricedModels: OpenRouterModelInfo[] = [],
  ) {}

  private rank(prompt: string): string {
    const labels = [...prompt.matchAll(/^Response ([A-Z]):\n(.*)$/gm)].map(([, label, body]) => ({
      label,
      preferred: body.includes(this.preferred),
    }));
    labels.sort((a, b) => Number(b.preferred) - Number(a.preferred));
    return `Reviews...\n\nFINAL RANKING:\n${labels.map((l, i) => `${i + 1}. Response ${l.label}`).join('\n')}`;
  }

  async query(): Promise<LlmResponse | null> {
    return { content: SYNTHESIS };
  }

  async queryStreaming(): Promise<LlmResponse | null> {
    return { content: SYNTHESIS };
  }

  async queryModelsParallelStreaming(
    models: string[],
    messages: Array<{ role: string; content: string }>,
    onModelStart?: (model: string) => void,
    onModelChunk?: (model: string, chunk: string) => void,
    onModelComplete?: (model: string, success: boolean) => void,
  ): Promise<Record<string, LlmResponse | null>> {
    const results: Record<string, LlmResponse | null> = {};
    for (const model of models) {
      onModelStart?.(model);
      const content = this.rank(messages[0].content);
      onModelChunk?.(model, content);
      onModelComplete?.(model, true);
      results[model] = { content };
    }
    return results;
  }

  async fetchModels() {
    return [];
  }

  getCachedOrFallbackModels() {
    return this.pricedModels;
  }

  clearModelCache(): void {}
}

type RecordedEvents = DeliberationEvents & {
  stages: number[];
  completed: RunRecord[];
  errors: string[];
};

function recordEvents(): RecordedEvents {
  const recorded = {
    stages: [] as number[],
    completed: [] as RunRecord[],
    errors: [] as string[],
    onStageChange: (stage: number) => recorded.stages.push(stage),
    onAgentStatus: () => {},
    onAgentEvent: () => {},
    onJurorStatus: () => {},
    onJurorChunk: () => {},
    onJurorComplete: () => {},
    onSynthesisStart: () => {},
    onComplete: (record: RunRecord) => recorded.completed.push(record),
    onError: (error: string) => recorded.errors.push(error),
  };
  return recorded;
}

function agent(provider: AgentProviderType, model: string): AgentInstance {
  return { instanceId: `${provider}-1`, provider, model, enabled: true };
}

const AGENTS = [agent('claude', 'sonnet'), agent('codex', 'gpt-5.2-codex')];

describe('DeliberationService (offline, fake CLI drivers)', () => {
  let tmp: string;
  let configStore: JsonConfigStore;
  let runRepository: JsonRunRepository;
  let drivers: Map<string, FakeCliDriver>;
  const secretStore = new PlaintextSecretStore();

  beforeAll(() => setLogLevel('error'));

  beforeEach(async () => {
    // Only the temp config may supply council settings.
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('COUNCIL_MODELS', '');
    vi.stubEnv('CHAIRMAN_MODEL', '');
    vi.stubEnv('OPENROUTER_API_URL', '');
    tmp = await mkdtemp(join(tmpdir(), 'concilium-e2e-'));
    configStore = new JsonConfigStore(join(tmp, 'config'));
    runRepository = new JsonRunRepository(join(tmp, 'data'));
    await configStore.saveCouncilConfigPrefs({
      apiKeyEncrypted: secretStore.encrypt('fake-key-never-sent'),
      councilModels: JURORS,
      chairmanModel: CHAIRMAN,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  async function createService(
    plans: Record<string, string | Error>,
    events: DeliberationEvents,
    pricedModels: OpenRouterModelInfo[] = [],
  ): Promise<DeliberationService> {
    drivers = new Map(Object.entries(plans).map(([id, plan]) => [id, planDriver(id, plan)]));
    return new DeliberationService({
      drivers,
      llmGateway: new FakeLlmGateway(PLANS.codex, pricedModels),
      config: await new ConfigService(configStore, secretStore).resolve(),
      runRepository,
      events,
    });
  }

  it('should run all three stages and persist the run', async () => {
    const events = recordEvents();
    const record = await (await createService(PLANS, events)).run({ prompt: PROMPT, agentInstances: AGENTS, cwd: tmp });

    expect(record.prompt).toBe(PROMPT);
    expect(record.stage1).toEqual([
      { model: 'claude · sonnet', response: PLANS.claude },
      { model: 'codex · gpt-5.2-codex', response: PLANS.codex },
    ]);

    expect(record.stage2.map((r) => r.model)).toEqual(JURORS);
    expect(record.metadata.aggregateRankings).toEqual([
      { model: 'codex · gpt-5.2-codex', averageRank: 1, rankingsCount: 2 },
      { model: 'claude · sonnet', averageRank: 2, rankingsCount: 2 },
    ]);

    expect(record.stage3).toMatchObject({ model: CHAIRMAN, response: SYNTHESIS });

    expect(events.stages).toEqual([1, 2, 3]);
    expect(events.errors).toEqual([]);
    expect(events.completed).toEqual([record]);

    expect(await runRepository.load(record.id)).toEqual(record);
    expect(await runRepository.list()).toEqual([
      { id: record.id, createdAt: record.createdAt, promptPreview: PROMPT, status: 'success' },
    ]);
  });

  it('should give each agent a read-only plan brief for the prompt in the run directory, with its model', async () => {
    await (await createService(PLANS, recordEvents())).run({ prompt: PROMPT, agentInstances: AGENTS, cwd: tmp });

    const [run] = drivers.get('claude')!.runs;
    expect(run.brief).toMatchObject({ mode: 'plan', cwd: tmp });
    expect(run.brief.allowedActions).not.toContain('write');
    expect(run.brief.allowedActions).not.toContain('shell');
    expect(run.brief.task).toContain(PROMPT);
    expect(run.opts).toMatchObject({ cwd: tmp, model: 'sonnet' });
    expect(drivers.get('codex')!.runs[0].opts.model).toBe('gpt-5.2-codex');
  });

  it('should hand inline images to agents as files and remove them after the run', async () => {
    await (await createService(PLANS, recordEvents())).run({
      prompt: PROMPT,
      images: [{ mimeType: 'image/png', base64: Buffer.from('png bytes').toString('base64') }],
      agentInstances: AGENTS,
      cwd: tmp,
    });

    const imagePath = drivers.get('claude')!.runs[0].brief.task.match(/^- (\/.*image-1\.png)$/m)?.[1];
    expect(imagePath).toBeDefined();
    expect(existsSync(imagePath!)).toBe(false);
  });

  it('should fall back to the surviving plan when only one agent succeeds', async () => {
    const events = recordEvents();
    const service = await createService({ claude: PLANS.claude, codex: new Error('codex crashed') }, events);
    const record = await service.run({
      prompt: PROMPT,
      agentInstances: AGENTS,
      cwd: tmp,
    });

    expect(record.stage1).toEqual([{ model: 'claude · sonnet', response: PLANS.claude }]);
    expect(record.agents.find((a) => a.id === 'codex')).toMatchObject({ status: 'error', errors: ['codex crashed'] });
    expect(record.stage2).toEqual([]);
    expect(record.stage3).toMatchObject({ model: CHAIRMAN, response: PLANS.claude });
    expect(record.metadata.notes).toContain('Fewer than 2 successful Stage 1 plans; Stage 2 ranking skipped.');
    expect((await runRepository.list())[0]).toMatchObject({ id: record.id, status: 'partial_error' });
  });

  it('should skip judging and synthesis when no OpenRouter key is configured', async () => {
    await configStore.saveCouncilConfigPrefs({ councilModels: JURORS, chairmanModel: CHAIRMAN });
    const events = recordEvents();
    const record = await (await createService(PLANS, events)).run({ prompt: PROMPT, agentInstances: AGENTS, cwd: tmp });

    expect(record.stage1).toHaveLength(2);
    expect(record.stage2).toEqual([]);
    expect(record.stage3?.model).toBe('chairman-unavailable');
    expect(record.metadata.notes).toContain('OPENROUTER_API_KEY is missing, Stage 2 and Stage 3 were skipped.');
  });

  it('should report an error and persist nothing when every agent fails', async () => {
    const events = recordEvents();
    const service = await createService({ claude: new Error('down'), codex: new Error('down') }, events);

    await expect(service.run({ prompt: PROMPT, agentInstances: AGENTS, cwd: tmp })).rejects.toThrow(
      'All agents failed or were aborted. No responses to judge.',
    );
    expect(events.errors).toContain('All agents failed or were aborted. No responses to judge.');
    expect(events.completed).toEqual([]);
    expect(await runRepository.list()).toEqual([]);
  });

  it('should rank two agents with the same provider and no model separately', async () => {
    const agents: AgentInstance[] = [
      { instanceId: 'opencode-1', provider: 'opencode', model: '', enabled: true },
      { instanceId: 'opencode-2', provider: 'opencode', model: '', enabled: true },
    ];
    const record = await (await createService({ opencode: PLANS.claude }, recordEvents())).run({
      prompt: PROMPT,
      agentInstances: agents,
      cwd: tmp,
    });

    expect(record.stage1.map((r) => r.model)).toEqual(['opencode', 'opencode #2']);
    expect(record.metadata.aggregateRankings).toEqual([
      { model: 'opencode', averageRank: 1, rankingsCount: 2 },
      { model: 'opencode #2', averageRank: 2, rankingsCount: 2 },
    ]);
    expect(Object.keys(record.metadata.modelSnapshots ?? {})).toEqual(['opencode', 'opencode #2']);
  });

  it('should not price subscription CLI agents with API per-token prices', async () => {
    const pricedModels: OpenRouterModelInfo[] = [
      { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2 Codex', context_length: 1, pricing: { prompt: 2, completion: 8 } },
    ];
    const agents = [agent('claude', ''), agent('codex', 'openai/gpt-5.2-codex')];
    const record = await (await createService(PLANS, recordEvents(), pricedModels)).run({
      prompt: PROMPT,
      agentInstances: agents,
      cwd: tmp,
    });

    const snapshots = record.metadata.modelSnapshots ?? {};
    expect(Object.keys(snapshots)).toEqual(['claude', 'codex · gpt-5.2-codex']);
    for (const snapshot of Object.values(snapshots)) {
      expect(snapshot.costPer1kTokens).toBeNull();
    }
  });
});
