/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LlmGateway, LlmResponse } from '../../ports/llm-gateway.js';
import { setLogLevel } from '../../shared/logger.js';
import { CliCouncilGateway, COUNCIL_PROMPT_FILE } from './cli-council-gateway.js';
import { FakeCliDriver } from './fake-cli-driver.js';

const PROMPT = [{ role: 'user', content: 'Rank these plans.\nFINAL RANKING:' }];

/** A juror that answers with the prompt file it was pointed at, so the test sees what it read. */
function echoJuror(id: string, seen: { prompt?: string; cwd?: string } = {}): FakeCliDriver {
  return new FakeCliDriver({
    id,
    respond: (brief) => {
      seen.cwd = brief.cwd;
      seen.prompt = readFileSync(join(brief.cwd, COUNCIL_PROMPT_FILE), 'utf8');
      return [
        { type: 'text', text: `${id} read: ` },
        { type: 'text', text: seen.prompt },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
      ];
    },
  });
}

describe('CliCouncilGateway', () => {
  beforeAll(() => setLogLevel('error'));

  it('should run a CLI juror on a read-only plan brief that points at the prompt file in a temp dir', async () => {
    const seen: { prompt?: string; cwd?: string } = {};
    const codex = echoJuror('codex', seen);
    const gateway = new CliCouncilGateway({ drivers: new Map([['codex', codex]]) });
    const chunks: string[] = [];

    const response = await gateway.queryStreaming('codex:gpt-5.2', PROMPT, (chunk) => chunks.push(chunk));

    expect(response).toEqual({
      content: `codex read: ${PROMPT[0].content}`,
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });
    expect(chunks).toEqual(['codex read: ', PROMPT[0].content]);
    const [run] = codex.runs;
    expect(run.brief).toMatchObject({ mode: 'plan', allowedActions: ['read'], cwd: seen.cwd });
    expect(run.brief.task).toContain(COUNCIL_PROMPT_FILE);
    // Isolated from the user's hooks and plugins, so their output cannot reach the answer.
    expect(run.opts).toMatchObject({ cwd: seen.cwd, model: 'gpt-5.2', isolated: true });
    expect(existsSync(seen.cwd!)).toBe(false);
  });

  it('should run the CLI default model for a bare CLI spec', async () => {
    const claude = echoJuror('claude');
    await new CliCouncilGateway({ drivers: new Map([['claude', claude]]) }).query('claude', PROMPT);

    expect(claude.runs[0].opts.model).toBeUndefined();
  });

  it('should report each juror of a parallel call, and a failed or missing CLI as null', async () => {
    const failing = new FakeCliDriver({ id: 'gemini', events: [{ type: 'rate_limit', message: 'quota exceeded' }] });
    const gateway = new CliCouncilGateway({ drivers: new Map([['claude', echoJuror('claude')], ['gemini', failing]]) });
    const completed: Array<[string, boolean]> = [];

    const results = await gateway.queryModelsParallelStreaming(['claude', 'gemini', 'codex'], PROMPT, undefined, undefined, (model, ok) =>
      completed.push([model, ok]),
    );

    expect(results.claude?.content).toMatch(/^claude read: /);
    expect(results.gemini).toBeNull();
    expect(results.codex).toBeNull();
    expect(completed.sort()).toEqual([
      ['claude', true],
      ['codex', false],
      ['gemini', false],
    ]);
  });

  it('should send OpenRouter ids to OpenRouter only when it is configured', async () => {
    const asked: string[] = [];
    const openRouter = {
      queryStreaming: async (model: string): Promise<LlmResponse> => {
        asked.push(model);
        return { content: 'from openrouter' };
      },
    } as unknown as LlmGateway;

    expect(await new CliCouncilGateway({ drivers: new Map() }).query('openai/gpt-5.2', PROMPT)).toBeNull();
    expect(await new CliCouncilGateway({ drivers: new Map(), openRouter }).query('openai/gpt-5.2', PROMPT)).toEqual({ content: 'from openrouter' });
    expect(asked).toEqual(['openai/gpt-5.2']);
  });

  it('should abort a CLI juror when the run is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const claude = echoJuror('claude');

    const response = await new CliCouncilGateway({ drivers: new Map([['claude', claude]]) }).query('claude', PROMPT, undefined, controller.signal);

    expect(response).toBeNull();
    expect(claude.runs[0].opts.signal.aborted).toBe(true);
  });
});
