import type {
  AggregateRanking,
  CouncilConfig,
  RunMetadata,
  Stage1Result,
  Stage2Result,
  Stage3Result,
} from './types';
import { queryModel, queryModelsParallelStreaming } from './openrouter';
import { createLogger } from './logger';

const log = createLogger('pipeline');

export function parseRankingFromText(rankingText: string): string[] {
  if (rankingText.includes('FINAL RANKING:')) {
    const rankingSection = rankingText.split('FINAL RANKING:').slice(1).join('');
    const numberedMatches = rankingSection.match(/\d+\.\s*Response [A-Z]/g);
    if (numberedMatches) {
      return numberedMatches
        .map((m) => m.match(/Response [A-Z]/)?.[0])
        .filter((m): m is string => m != null);
    }
    const fallback = rankingSection.match(/Response [A-Z]/g);
    return fallback ?? [];
  }
  return rankingText.match(/Response [A-Z]/g) ?? [];
}

export function calculateAggregateRankings(
  stage2Results: Stage2Result[],
  labelToModel: Record<string, string>,
): AggregateRanking[] {
  const modelPositions: Record<string, number[]> = {};

  for (const ranking of stage2Results) {
    const parsed = parseRankingFromText(ranking.ranking);
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

  const prompt = `You are evaluating different responses to the following question:

Question: ${userQuery}

Here are the responses from different models (anonymized):

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
  const stage1Text = stage1Results
    .map((r) => `Model: ${r.model}\nResponse: ${r.response}`)
    .join('\n\n');
  const stage2Text = stage2Results
    .map((r) => `Model: ${r.model}\nRanking: ${r.ranking}`)
    .join('\n\n');

  return `You are the Chairman of an LLM Council. Multiple AI models have provided responses to a user's question, and then ranked each other's responses.

Original Question: ${userQuery}

STAGE 1 - Individual Responses:
${stage1Text}

STAGE 2 - Peer Rankings:
${stage2Text}

Your task as Chairman is to synthesize all of this information into a single, comprehensive, accurate answer to the user's original question. Consider:
- The individual responses and their insights
- The peer rankings and what they reveal about response quality
- Any patterns of agreement or disagreement

Provide a clear, well-reasoned final answer that represents the council's collective wisdom:`;
}

import type { OpenRouterUsage } from './openrouter';

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

  const rankingResponses = await queryModelsParallelStreaming(
    config,
    config.councilModels,
    rankingMessages,
    callbacks?.onRankingModelStart,
    callbacks?.onRankingModelChunk,
    callbacks?.onRankingModelComplete,
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
    log.debug(`runCouncilStages: ${model} ranking parsed:`, parsed);
    stage2.push({
      model,
      ranking: rankingText,
      parsedRanking: parsed,
      usage: response.usage ?? null,
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
  
  const synthesis = await queryModel(config, config.chairmanModel, [{ role: 'user', content: synthesisPrompt }], 180_000);

  if (!synthesis) {
    log.error('runCouncilStages: chairman synthesis failed!');
  } else {
    log.info(`runCouncilStages: chairman synthesis complete, length: ${synthesis.content.length} chars`);
  }

  const stage3: Stage3Result = {
    model: config.chairmanModel,
    response: synthesis?.content ?? 'Error: Unable to generate final synthesis from chairman model.',
    usage: synthesis?.usage ?? null,
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
