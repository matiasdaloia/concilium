/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentResult } from '../domain/agent/agent-result.js';
import type { ParsedEvent } from '../domain/agent/parsed-event.js';
import type { RunRecord } from '../domain/run/run-record.js';
import { JsonRunRepository } from './json-run-repository.js';

function agentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    id: 'claude',
    agentKey: 'claude-1',
    name: 'claude · opus',
    status: 'success',
    normalizedPlan: 'Plan',
    errors: [],
    command: ['claude', '--print'],
    events: [],
    ...overrides,
  };
}

function runRecord(id: string, createdAt: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    createdAt,
    prompt: `Prompt for ${id}`,
    cwd: '/repo',
    selectedAgents: ['claude'],
    agents: [agentResult()],
    stage1: [{ model: 'claude · opus', response: 'Plan' }],
    stage2: [{ model: 'juror/one', ranking: 'FINAL RANKING:\n1. Response A', parsedRanking: ['Response A'] }],
    stage3: { model: 'chairman/one', response: 'Synthesis' },
    metadata: { labelToModel: { 'Response A': 'claude · opus' }, aggregateRankings: [] },
    ...overrides,
  };
}

function usage(inputTokens: number, outputTokens: number, totalCost: number | null, cumulative = false): ParsedEvent {
  return {
    eventType: 'status',
    text: 'turn',
    rawLine: '{}',
    tokenUsage: { inputTokens, outputTokens, totalCost },
    ...(cumulative ? { tokenUsageCumulative: true } : {}),
  };
}

describe('JsonRunRepository', () => {
  let dataDir: string;
  let repo: JsonRunRepository;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'concilium-runs-'));
    repo = new JsonRunRepository(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('should load back exactly the record it saved, from <dataDir>/runs/<id>.json', async () => {
    const record = runRecord('run-1', '2026-01-01T00:00:00.000Z', {
      agents: [agentResult({ rawOutput: ['line'], events: [usage(1, 2, null)] })],
    });

    const path = await repo.save(record);

    expect(path).toBe(join(dataDir, 'runs', 'run-1.json'));
    expect(await repo.load('run-1')).toEqual(record);
  });

  it('should reject loading a run that does not exist', async () => {
    await expect(repo.load('missing')).rejects.toThrow();
  });

  it('should list nothing in a fresh data directory', async () => {
    expect(await repo.list()).toEqual([]);
    expect(await repo.loadAll()).toEqual([]);
  });

  it('should list and load runs newest first, whatever the file names', async () => {
    await repo.save(runRecord('a-oldest', '2026-01-01T00:00:00.000Z'));
    await repo.save(runRecord('b-newest', '2026-03-01T00:00:00.000Z'));
    await repo.save(runRecord('c-middle', '2026-02-01T00:00:00.000Z'));

    expect((await repo.list()).map((r) => r.id)).toEqual(['b-newest', 'c-middle', 'a-oldest']);
    expect((await repo.loadAll()).map((r) => r.id)).toEqual(['b-newest', 'c-middle', 'a-oldest']);
  });

  it('should summarize each run with a 70-character prompt preview and an overall status', async () => {
    const created = '2026-01-01T00:00:00.000Z';
    await repo.save(runRecord('ok', created, { prompt: 'x'.repeat(100) }));
    await repo.save(runRecord('partial', '2026-01-02T00:00:00.000Z', {
      agents: [agentResult(), agentResult({ status: 'error' })],
    }));
    await repo.save(runRecord('running', '2026-01-03T00:00:00.000Z', {
      agents: [agentResult({ status: 'error' }), agentResult({ status: 'running' })],
    }));
    await repo.save(runRecord('mixed', '2026-01-04T00:00:00.000Z', {
      agents: [agentResult(), agentResult({ status: 'cancelled' })],
    }));

    const byId = Object.fromEntries((await repo.list()).map((s) => [s.id, s]));

    expect(byId.ok).toEqual({ id: 'ok', createdAt: created, promptPreview: 'x'.repeat(70), status: 'success' });
    expect(byId.partial.status).toBe('partial_error');
    expect(byId.running.status).toBe('running');
    expect(byId.mixed.status).toBe('mixed');
  });

  it('should load all runs without raw output, keeping only each agent\'s final token usage', async () => {
    await repo.save(runRecord('summed', '2026-01-01T00:00:00.000Z', {
      agents: [agentResult({ rawOutput: ['noise'], events: [usage(10, 5, 0.01), usage(3, 2, 0.02)] })],
    }));
    await repo.save(runRecord('cumulative', '2026-01-02T00:00:00.000Z', {
      agents: [agentResult({ events: [usage(10, 5, null), usage(40, 20, 0.5, true)] })],
    }));
    await repo.save(runRecord('no-usage', '2026-01-03T00:00:00.000Z', {
      agents: [agentResult({ events: [{ eventType: 'text', text: 'hi', rawLine: 'hi' }] })],
    }));

    const byId = Object.fromEntries((await repo.loadAll()).map((r) => [r.id, r.agents[0]]));

    expect(byId.summed.rawOutput).toBeUndefined();
    expect(byId.summed.events).toHaveLength(1);
    expect(byId.summed.events[0].tokenUsage?.inputTokens).toBe(13);
    expect(byId.summed.events[0].tokenUsage?.outputTokens).toBe(7);
    expect(byId.summed.events[0].tokenUsage?.totalCost).toBeCloseTo(0.03);
    expect(byId.cumulative.events.map((e) => e.tokenUsage)).toEqual([
      { inputTokens: 40, outputTokens: 20, totalCost: 0.5 },
    ]);
    expect(byId['no-usage'].events).toEqual([]);
    expect(byId.summed.normalizedPlan).toBe('Plan');
  });

  it('should skip corrupt and non-JSON files when listing, and keep the good runs', async () => {
    await repo.save(runRecord('good', '2026-01-01T00:00:00.000Z'));
    const runsDir = join(dataDir, 'runs');
    await writeFile(join(runsDir, 'truncated.json'), '{"id":"truncated","createdAt":');
    await writeFile(join(runsDir, 'wrong-shape.json'), '{"id":"wrong-shape"}');
    await writeFile(join(runsDir, 'notes.txt'), 'not a run');

    expect((await repo.list()).map((r) => r.id)).toEqual(['good']);
    expect((await repo.loadAll()).map((r) => r.id)).toEqual(['good']);
    expect(await readdir(runsDir)).toHaveLength(4);
  });
});
