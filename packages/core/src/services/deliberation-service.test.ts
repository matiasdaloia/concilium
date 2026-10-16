/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstance, AgentProviderType } from '../domain/agent/agent-config.js';
import type { OpenRouterModelInfo } from '../domain/council/model-info.js';
import type { RunRecord } from '../domain/run/run-record.js';
import type { DeliberationEvents } from '../ports/deliberation-events.js';
import type { LlmGateway } from '../ports/llm-gateway.js';
import { CliCouncilGateway, COUNCIL_PROMPT_FILE } from '../adapters/cli/cli-council-gateway.js';
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
/** CLI council members: two jurors and a chairman, all run through fake agent CLIs. */
const JURORS = ['claude', 'codex:gpt-5.2'];
const CHAIRMAN = 'gemini';
const SYNTHESIS = 'Final plan: sliding window in Redis, with middleware fallback';

/** Jurors rank whichever anonymized response contains the codex plan first. */
function rank(prompt: string): string {
  const labels = [...prompt.matchAll(/^Response ([A-Z]):\n(.*)$/gm)].map(([, label, body]) => ({
    label,
    preferred: body.includes(PLANS.codex),
  }));
  labels.sort((a, b) => Number(b.preferred) - Number(a.preferred));
  return `Reviews...\n\nFINAL RANKING:\n${labels.map((l, i) => `${i + 1}. Response ${l.label}`).join('\n')}`;
}

/**
 * A fake agent CLI without a process. As a Stage 1 agent it streams `plan` (or fails with it).
 * As a juror or chairman it reads the prompt file the council brief points at: it ranks a
 * ranking prompt and answers anything else with SYNTHESIS.
 */
function fakeCli(id: string, plan: string | Error = new Error(`${id} has no plan`)): FakeCliDriver {
  return new FakeCliDriver({
    id,
    respond: (brief) => {
      if (brief.task.includes(COUNCIL_PROMPT_FILE)) {
        const prompt = readFileSync(join(brief.cwd, COUNCIL_PROMPT_FILE), 'utf8');
        return [{ type: 'text', text: prompt.includes('provide your code review and ranking') ? rank(prompt) : SYNTHESIS }];
      }
      return plan instanceof Error ? [{ type: 'error', message: plan.message }] : [{ type: 'text', text: plan }];
    },
  });
}

/** OpenRouter's price list, which must never price a subscription CLI run. */
function priceList(models: OpenRouterModelInfo[]): LlmGateway {
  return { getCachedOrFallbackModels: () => models } as unknown as LlmGateway;
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
    // No OpenRouter key anywhere: every stage runs on the (fake) agent CLIs.
    await configStore.saveCouncilConfigPrefs({ councilModels: JURORS, chairmanModel: CHAIRMAN });
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
    drivers = new Map(['claude', 'codex', 'gemini', 'opencode'].map((id) => [id, fakeCli(id, plans[id])]));
    return new DeliberationService({
      drivers,
      llmGateway: new CliCouncilGateway({ drivers, openRouter: priceList(pricedModels) }),
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

  it('should judge on read-only council briefs that hold no API key and price no CLI juror', async () => {
    const pricedModels: OpenRouterModelInfo[] = [{ id: 'claude', name: 'Claude', context_length: 1, pricing: { prompt: 2, completion: 8 } }];
    const record = await (await createService(PLANS, recordEvents(), pricedModels)).run({ prompt: PROMPT, agentInstances: AGENTS, cwd: tmp });

    const councilRuns = [...drivers.values()].flatMap((d) => d.runs).filter((r) => r.brief.task.includes(COUNCIL_PROMPT_FILE));
    expect(councilRuns).toHaveLength(3);
    for (const { brief, opts } of councilRuns) {
      expect(brief).toMatchObject({ mode: 'plan', allowedActions: ['read'] });
      expect(opts.cwd).not.toBe(tmp);
    }
    expect(drivers.get('codex')!.runs.map((r) => r.opts.model)).toEqual(['gpt-5.2-codex', 'gpt-5.2']);
    expect(record.stage2.map((r) => r.estimatedCost)).toEqual([null, null]);
    expect(record.stage3?.estimatedCost).toBeNull();
  });

  it('should drop a juror whose CLI fails and synthesize from the others', async () => {
    await configStore.saveCouncilConfigPrefs({ councilModels: [...JURORS, 'opencode:broken/model'], chairmanModel: CHAIRMAN });
    const service = await createService(PLANS, recordEvents());
    drivers.set('opencode', new FakeCliDriver({ id: 'opencode', events: [{ type: 'error', message: 'boom' }] }));

    const record = await service.run({ prompt: PROMPT, agentInstances: AGENTS, cwd: tmp });

    expect(record.stage2.map((r) => r.model)).toEqual(JURORS);
    expect(record.metadata.notes).toContain('Ranking model failed: opencode:broken/model');
    expect(record.stage3).toMatchObject({ model: CHAIRMAN, response: SYNTHESIS });
  });

  it('should skip judging and synthesis when no juror is available', async () => {
    await configStore.saveCouncilConfigPrefs({});
    const events = recordEvents();
    const record = await (await createService(PLANS, events)).run({ prompt: PROMPT, agentInstances: AGENTS, cwd: tmp });

    expect(record.stage1).toHaveLength(2);
    expect(record.stage2).toEqual([]);
    expect(record.stage3?.model).toBe('chairman-unavailable');
    expect(record.metadata.notes).toContain('No juror is available, Stage 2 and Stage 3 were skipped.');
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
