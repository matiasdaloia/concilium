import type { AggregateRanking } from '../run/run-metadata.js';
import type { Stage2Result } from '../council/stage-results.js';

export function parseRankingFromText(rankingText: string): string[] {
  const normalize = (matches: string[]): string[] =>
    matches.map((m) => {
      const letter = m.match(/[A-Za-z]$/)?.[0]?.toUpperCase();
      return letter ? `Response ${letter}` : m;
    });

  const finalRankingIdx = rankingText.search(/FINAL RANKING:/i);
  if (finalRankingIdx !== -1) {
    const rankingSection = rankingText.slice(finalRankingIdx);
    const numberedMatches = rankingSection.match(/\d+\.\s*[Rr]esponse\s+[A-Za-z]/g);
    if (numberedMatches) {
      return normalize(
        numberedMatches
          .map((m) => m.match(/[Rr]esponse\s+[A-Za-z]/)?.[0] ?? '')
          .filter(Boolean),
      );
    }
    const fallback = rankingSection.match(/[Rr]esponse\s+[A-Za-z]/g);
    return fallback ? normalize(fallback) : [];
  }
  const allMatches = rankingText.match(/[Rr]esponse\s+[A-Za-z]/g);
  return allMatches ? normalize(allMatches) : [];
}

export function calculateAggregateRankings(
  stage2Results: Stage2Result[],
  labelToModel: Record<string, string>,
): AggregateRanking[] {
  const modelPositions: Record<string, number[]> = {};

  for (const ranking of stage2Results) {
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
