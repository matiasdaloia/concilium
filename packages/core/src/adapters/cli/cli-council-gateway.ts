/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCouncilMember } from '../../domain/council/council-members.js';
import type { OpenRouterModelInfo } from '../../domain/council/model-info.js';
import type { CouncilTokenUsage } from '../../domain/council/stage-results.js';
import type { Brief } from '../../domain/driver/brief.js';
import type { Report } from '../../domain/driver/report.js';
import type { HeadlessCliDriver } from '../../ports/headless-cli-driver.js';
import type { LlmGateway, LlmResponse } from '../../ports/llm-gateway.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('cli-council-gateway');

/** The file a juror or chairman reads its prompt from. Prompts carry every plan, too long for one argv entry. */
export const COUNCIL_PROMPT_FILE = 'council-prompt.md';

/** Wall-clock limit for one juror or chairman CLI run. Shorter HTTP timeouts passed by the pipeline do not apply. */
export const COUNCIL_TIMEOUT_MS = 15 * 60_000;

/** A read-only plan brief that points the CLI at the prompt file in `cwd`. */
export function councilBrief(cwd: string): Brief {
  return {
    version: 1,
    task: `Read the file ${COUNCIL_PROMPT_FILE} in the current directory and follow its instructions. Reply with your answer as text; do not write any files.`,
    mode: 'plan',
    cwd,
    constraints: [],
    allowedActions: ['read'],
  };
}

type Messages = Array<{ role: string; content: string }>;

/**
 * Answers juror and chairman prompts through the agent CLIs, under the user's own logins.
 * A CLI member (`claude`, `codex:<model>`) runs a read-only plan brief in a fresh temp directory that holds only
 * the prompt file. An OpenRouter model id goes to `openRouter`, which is only set when an API key is configured.
 */
export class CliCouncilGateway implements LlmGateway {
  constructor(
    private readonly options: {
      drivers: ReadonlyMap<string, HeadlessCliDriver>;
      openRouter?: LlmGateway | null;
      timeoutMs?: number;
    },
  ) {}

  query(model: string, messages: Messages, timeoutMs?: number, signal?: AbortSignal): Promise<LlmResponse | null> {
    return this.queryStreaming(model, messages, () => {}, timeoutMs, signal);
  }

  async queryStreaming(
    model: string,
    messages: Messages,
    onChunk: (text: string) => void,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<LlmResponse | null> {
    const member = parseCouncilMember(model);
    if (member.kind === 'cli') return this.runCli(model, member.cli, member.model, messages, onChunk, signal);
    if (!this.options.openRouter) {
      log.error(`${model}: OpenRouter model ids need an OpenRouter API key`);
      return null;
    }
    return this.options.openRouter.queryStreaming(model, messages, onChunk, timeoutMs, signal);
  }

  async queryModelsParallelStreaming(
    models: string[],
    messages: Messages,
    onModelStart?: (model: string) => void,
    onModelChunk?: (model: string, chunk: string) => void,
    onModelComplete?: (model: string, success: boolean, usage?: CouncilTokenUsage) => void,
    signal?: AbortSignal,
  ): Promise<Record<string, LlmResponse | null>> {
    const entries = await Promise.all(
      models.map(async (model) => {
        onModelStart?.(model);
        const response = await this.queryStreaming(model, messages, (chunk) => onModelChunk?.(model, chunk), undefined, signal);
        onModelComplete?.(model, response !== null, response?.usage);
        return [model, response] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  fetchModels(): Promise<OpenRouterModelInfo[]> {
    return this.options.openRouter?.fetchModels() ?? Promise.resolve([]);
  }

  getCachedOrFallbackModels(): OpenRouterModelInfo[] {
    return this.options.openRouter?.getCachedOrFallbackModels() ?? [];
  }

  clearModelCache(): void {
    this.options.openRouter?.clearModelCache();
  }

  private async runCli(
    spec: string,
    cli: string,
    model: string | undefined,
    messages: Messages,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<LlmResponse | null> {
    const driver = this.options.drivers.get(cli);
    if (!driver) {
      log.error(`${spec}: no driver for ${cli}`);
      return null;
    }

    const cwd = await mkdtemp(join(tmpdir(), 'concilium-council-'));
    try {
      await writeFile(join(cwd, COUNCIL_PROMPT_FILE), messages.map((m) => m.content).join('\n\n'));
      // Isolated: the user's hooks and plugins would write into the answer this gateway parses.
      const runOptions = { cwd, model, timeoutMs: this.options.timeoutMs ?? COUNCIL_TIMEOUT_MS, signal: signal ?? new AbortController().signal, isolated: true };
      let report: Report | undefined;
      for await (const event of driver.run(councilBrief(cwd), runOptions)) {
        if (event.type === 'text') onChunk(event.text);
        if (event.type === 'done') report = event.report;
      }

      const content = report?.status === 'ok' ? report.finalText.trim() : '';
      if (!report || !content) {
        log.warn(`${spec}: ${report ? `${report.status}: ${report.errors.join('; ') || 'no answer'}` : 'no report'}`);
        return null;
      }
      if (!report.usage) return { content };
      const { inputTokens, outputTokens } = report.usage;
      return { content, usage: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens } };
    } catch (err) {
      log.error(`${spec}: failed:`, err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
