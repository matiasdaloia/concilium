import type { CouncilConfig } from '../council/council-config.js';
import type { CouncilTokenUsage, Stage1Result, Stage2Result, Stage3Result } from '../council/stage-results.js';
import type { RunMetadata } from '../run/run-metadata.js';
import type { LlmGateway, LlmResponse } from '../../ports/llm-gateway.js';
import type { OpenRouterModelInfo } from '../council/model-info.js';
import { parseRankingFromText, calculateAggregateRankings } from './ranking.js';
import { buildRankingPrompt, buildSynthesisPrompt } from './prompts.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('pipeline');

function estimateCost(
  modelId: string,
  usage: { promptTokens: number; completionTokens: number } | null | undefined,
  cachedModels: OpenRouterModelInfo[],
): number | null {
  if (!usage) return null;
  const model = cachedModels.find(m => m.id === modelId);
  if (!model) return null;
  const promptCost = (usage.promptTokens / 1_000_000) * model.pricing.prompt;
  const completionCost = (usage.completionTokens / 1_000_000) * model.pricing.completion;
  const total = promptCost + completionCost;
  return total > 0 ? total : null;
}

export interface CouncilProgressCallbacks {
  onRankingModelStart?: (model: string) => void;
  onRankingModelChunk?: (model: string, chunk: string) => void;
  onRankingModelComplete?: (model: string, success: boolean, usage?: CouncilTokenUsage) => void;
  onSynthesisStart?: () => void;
}

export async function runCouncilStages(options: {
  config: CouncilConfig;
  userPrompt: string;
  stage1Results: Stage1Result[];
  callbacks?: CouncilProgressCallbacks;
  llmGateway: LlmGateway;
}): Promise<[Stage2Result[], Stage3Result, RunMetadata]> {
  const { config, userPrompt, stage1Results, callbacks, llmGateway } = options;
  const notes: string[] = [];

  log.info(`runCouncilStages: starting with ${stage1Results.length} stage1 results`);
  log.debug(`runCouncilStages: council models:`, config.councilModels);
  log.debug(`runCouncilStages: chairman model:`, config.chairmanModel);
  log.debug(`runCouncilStages: API key present:`, !!config.openRouterApiKey);

  if (!config.openRouterApiKey) {
    log.error('runCouncilStages: OPENROUTER_API_KEY is missing!');
    notes.push('OPENROUTER_API_KEY is missing, Stage 2 and Stage 3 were skipped.');
    return [
      [],
      {
        model: 'chairman-unavailable',
        response: 'Stage 2/3 are unavailable because OPENROUTER_API_KEY is not configured. Showing Stage 1 output only.',
      },
      { labelToModel: {}, aggregateRankings: [], notes },
    ];
  }

  if (stage1Results.length < 2) {
    log.warn('runCouncilStages: fewer than 2 stage1 results, skipping ranking');
    notes.push('Fewer than 2 successful Stage 1 plans; Stage 2 ranking skipped.');
    const response = stage1Results[0]?.response ?? 'Insufficient Stage 1 outputs to perform ranking and synthesis.';
    return [
      [],
      { model: config.chairmanModel, response },
      { labelToModel: {}, aggregateRankings: [], notes },
    ];
  }

  const [rankingPrompt, labelToModel] = buildRankingPrompt(userPrompt, stage1Results);
  const rankingMessages = [{ role: 'user', content: rankingPrompt }];

  log.info('runCouncilStages: STAGE 2 - starting ranking queries');
  log.debug('runCouncilStages: label mapping:', labelToModel);

  const jurorTimings = new Map<string, { startedAt: string; endedAt?: string }>();

  const rankingResponses = await llmGateway.queryModelsParallelStreaming(
    config.councilModels,
    rankingMessages,
    (model) => {
      jurorTimings.set(model, { startedAt: new Date().toISOString() });
      callbacks?.onRankingModelStart?.(model);
    },
    callbacks?.onRankingModelChunk,
    (model, success, usage) => {
      const timing = jurorTimings.get(model);
      if (timing) timing.endedAt = new Date().toISOString();
      callbacks?.onRankingModelComplete?.(model, success, usage);
    },
  );

  log.debug('runCouncilStages: ranking queries completed, processing results...');

  const cachedModels = llmGateway.getCachedOrFallbackModels();

  const stage2: Stage2Result[] = [];
  for (const [model, response] of Object.entries(rankingResponses)) {
    if (response === null) {
      log.error(`runCouncilStages: ranking model failed: ${model}`);
      notes.push(`Ranking model failed: ${model}`);
      continue;
    }
    const rankingText = response.content;
    const parsed = parseRankingFromText(rankingText);
    const timing = jurorTimings.get(model);
    log.debug(`runCouncilStages: ${model} ranking parsed:`, parsed);
    const usage = response.usage ?? null;
    stage2.push({
      model,
      ranking: rankingText,
      parsedRanking: parsed,
      usage,
      startedAt: timing?.startedAt ?? null,
      endedAt: timing?.endedAt ?? null,
      estimatedCost: estimateCost(model, usage, cachedModels),
    });
  }

  log.info(`runCouncilStages: ${stage2.length} successful rankings out of ${config.councilModels.length} models`);

  const aggregateRankings = calculateAggregateRankings(stage2, labelToModel);
  log.debug('runCouncilStages: aggregate rankings:', aggregateRankings);

  if (stage2.length === 0) {
    log.error('runCouncilStages: all Stage 2 ranking calls failed!');
    notes.push('All Stage 2 ranking calls failed; chairman synthesis skipped.');
    const degraded =
      'All Stage 2 ranking calls failed. Showing first Stage 1 plan as degraded fallback:\n\n' +
      stage1Results[0].response;
    return [
      stage2,
      { model: config.chairmanModel, response: degraded },
      { labelToModel, aggregateRankings, notes },
    ];
  }

  log.info('runCouncilStages: STAGE 3 - starting chairman synthesis');
  callbacks?.onSynthesisStart?.();

  const synthesisPrompt = buildSynthesisPrompt(userPrompt, stage1Results, stage2);
  log.debug(`runCouncilStages: synthesis prompt length: ${synthesisPrompt.length} chars`);

  const chairmanStartedAt = new Date().toISOString();
  const synthesis = await llmGateway.query(config.chairmanModel, [{ role: 'user', content: synthesisPrompt }], 180_000);
  const chairmanEndedAt = new Date().toISOString();

  if (!synthesis) {
    log.error('runCouncilStages: chairman synthesis failed!');
  } else {
    log.info(`runCouncilStages: chairman synthesis complete, length: ${synthesis.content.length} chars`);
  }

  const chairmanUsage = synthesis?.usage ?? null;
  const stage3: Stage3Result = {
    model: config.chairmanModel,
    response: synthesis?.content ?? 'Error: Unable to generate final synthesis from chairman model.',
    usage: chairmanUsage,
    startedAt: chairmanStartedAt,
    endedAt: chairmanEndedAt,
    estimatedCost: estimateCost(config.chairmanModel, chairmanUsage, cachedModels),
  };

  log.info('runCouncilStages: pipeline complete');

  return [
    stage2,
    stage3,
    {
      labelToModel,
      aggregateRankings,
      notes: notes.length > 0 ? notes : undefined,
    },
  ];
}
