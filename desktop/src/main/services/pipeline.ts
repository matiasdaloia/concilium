import type {
  AggregateRanking,
  CouncilConfig,
  ModelPerformanceSnapshot,
  RunMetadata,
  Stage1Result,
  Stage2Result,
  Stage3Result,
} from './types';
import { queryModel, queryModelsParallelStreaming, getCachedOrFallbackModels } from './openrouter';
import type { OpenRouterUsage } from './openrouter';
import { createLogger } from './logger';

const log = createLogger('pipeline');

export function parseRankingFromText(rankingText: string): string[] {
  // Normalize matches to canonical "Response X" format
  const normalize = (matches: string[]): string[] =>
    matches.map((m) => {
      const letter = m.match(/[A-Za-z]$/)?.[0]?.toUpperCase();
      return letter ? `Response ${letter}` : m;
    });

  // Case-insensitive search for "FINAL RANKING:" section
  const finalRankingIdx = rankingText.search(/FINAL RANKING:/i);
  if (finalRankingIdx !== -1) {
    const rankingSection = rankingText.slice(finalRankingIdx);
    // Match numbered entries like "1. Response A" (case-insensitive)
    const numberedMatches = rankingSection.match(/\d+\.\s*[Rr]esponse\s+[A-Za-z]/g);
    if (numberedMatches) {
      return normalize(
        numberedMatches
          .map((m) => m.match(/[Rr]esponse\s+[A-Za-z]/)?.[0] ?? '')
          .filter(Boolean),
      );
    }
    // Fallback: any "Response X" mention in the ranking section
    const fallback = rankingSection.match(/[Rr]esponse\s+[A-Za-z]/g);
    return fallback ? normalize(fallback) : [];
  }
  // No FINAL RANKING header — try to extract from full text
  const allMatches = rankingText.match(/[Rr]esponse\s+[A-Za-z]/g);
  return allMatches ? normalize(allMatches) : [];
}

export function calculateAggregateRankings(
  stage2Results: Stage2Result[],
  labelToModel: Record<string, string>,
): AggregateRanking[] {
  const modelPositions: Record<string, number[]> = {};

  for (const ranking of stage2Results) {
    // Use the already-parsed ranking to avoid re-parsing and inconsistency
    const parsed = ranking.parsedRanking.length > 0
      ? ranking.parsedRanking
      : parseRankingFromText(ranking.ranking);
    for (let i = 0; i < parsed.length; i++) {
      const label = parsed[i];
      const modelName = labelToModel[label];
      if (!modelName) continue;
      (modelPositions[modelName] ??= []).push(i + 1);
    }
  }

  const aggregate: AggregateRanking[] = [];
  for (const [model, positions] of Object.entries(modelPositions)) {
    if (positions.length === 0) continue;
    const avgRank = Math.round((positions.reduce((a, b) => a + b, 0) / positions.length) * 100) / 100;
    aggregate.push({ model, averageRank: avgRank, rankingsCount: positions.length });
  }

  aggregate.sort((a, b) => a.averageRank - b.averageRank);
  return aggregate;
}

function buildRankingPrompt(
  userQuery: string,
  stage1Results: Stage1Result[],
): [string, Record<string, string>] {
  const labels = stage1Results.map((_, i) => String.fromCharCode(65 + i));
  const labelToModel: Record<string, string> = {};
  for (let i = 0; i < labels.length; i++) {
    labelToModel[`Response ${labels[i]}`] = stage1Results[i].model;
  }

  const responsesText = labels
    .map((label, i) => `Response ${label}:\n${stage1Results[i].response}`)
    .join('\n\n');

  const prompt = `You are an impartial evaluator in a blind peer-review process. You are evaluating anonymized responses to a user question. You do NOT know which model or system produced each response.

IMPORTANT: Evaluate responses ONLY on their content quality — accuracy, completeness, clarity, and relevance. Ignore stylistic differences, formatting preferences, or any artifacts that might hint at the source. Each response is equally anonymous.

Question: ${userQuery}

Here are the anonymized responses:

${responsesText}

Your task:
1. First, evaluate each response individually. For each response, explain what it does well and what it does poorly.
2. Then, at the very end of your response, provide a final ranking.

IMPORTANT: Your final ranking MUST be formatted EXACTLY as follows:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Then list the responses from best to worst as a numbered list
- Each line should be: number, period, space, then ONLY the response label (e.g., "1. Response A")
- Do not add any other text or explanations in the ranking section

Example of the correct format for your ENTIRE response:

Response A provides good detail on X but misses Y...
Response B is accurate but lacks depth on Z...
Response C offers the most comprehensive answer...

FINAL RANKING:
1. Response C
2. Response A
3. Response B

Now provide your evaluation and ranking:`;

  return [prompt, labelToModel];
}

function buildSynthesisPrompt(
  userQuery: string,
  stage1Results: Stage1Result[],
  stage2Results: Stage2Result[],
): string {
  // Use the same anonymized labels as the ranking stage for consistency
  const labels = stage1Results.map((_, i) => String.fromCharCode(65 + i));

  const stage1Text = labels
    .map((label, i) => `Response ${label}:\n${stage1Results[i].response}`)
    .join('\n\n');
  const stage2Text = stage2Results
    .map((r, i) => `Juror ${i + 1} Evaluation:\n${r.ranking}`)
    .join('\n\n');

  return `You are the Chairman of an LLM Council. Multiple AI models have provided responses to a user's question, and independent jurors have evaluated and ranked those responses.

Original Question: ${userQuery}

STAGE 1 - Individual Responses (anonymized):
${stage1Text}

STAGE 2 - Peer Review Evaluations:
${stage2Text}

Your task as Chairman is to synthesize all of this information into a single, comprehensive, accurate answer to the user's original question. Consider:
- The individual responses and their unique insights
- The peer review evaluations and what they reveal about response quality
- Any patterns of agreement or disagreement between jurors
- Correct any errors identified by the jurors while preserving accurate insights

Provide a clear, well-reasoned final answer that represents the council's best collective knowledge. Do NOT reference the responses or jurors — write the answer as if you are directly answering the user:`;
}

/** Estimate cost in USD from token usage and cached model pricing */
function estimateCost(modelId: string, usage?: { promptTokens: number; completionTokens: number } | null): number | null {
  if (!usage) return null;
  const models = getCachedOrFallbackModels();
  const model = models.find(m => m.id === modelId);
  if (!model) return null;
  // pricing is per 1M tokens
  const promptCost = (usage.promptTokens / 1_000_000) * model.pricing.prompt;
  const completionCost = (usage.completionTokens / 1_000_000) * model.pricing.completion;
  const total = promptCost + completionCost;
  return total > 0 ? total : null;
}

export interface CouncilProgressCallbacks {
  onRankingModelStart?: (model: string) => void;
  onRankingModelChunk?: (model: string, chunk: string) => void;
  onRankingModelComplete?: (model: string, success: boolean, usage?: OpenRouterUsage) => void;
  onSynthesisStart?: () => void;
}

export async function runCouncilStages(options: {
  config: CouncilConfig;
  userPrompt: string;
  stage1Results: Stage1Result[];
  callbacks?: CouncilProgressCallbacks;
}): Promise<[Stage2Result[], Stage3Result, RunMetadata]> {
  const { config, userPrompt, stage1Results, callbacks } = options;
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

  // Track per-juror timing via callback wrappers
  const jurorTimings = new Map<string, { startedAt: string; endedAt?: string }>();

  const rankingResponses = await queryModelsParallelStreaming(
    config,
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
      estimatedCost: estimateCost(model, usage),
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
  const synthesis = await queryModel(config, config.chairmanModel, [{ role: 'user', content: synthesisPrompt }], 180_000);
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
    estimatedCost: estimateCost(config.chairmanModel, chairmanUsage),
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
