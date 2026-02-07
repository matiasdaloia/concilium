import type { AggregateRanking } from '../types';

interface LeaderboardProps {
  rankings: AggregateRanking[];
}

export default function Leaderboard({ rankings }: LeaderboardProps) {
  if (rankings.length === 0) return null;

  const maxRankings = Math.max(...rankings.map((r) => r.rankingsCount));

  return (
    <div className="bg-bg-surface border border-border-primary rounded-lg p-4">
      <h3 className="text-xs font-medium text-text-secondary mb-3 tracking-wide">Leaderboard</h3>
      <div className="space-y-2">
        {rankings.map((ranking, i) => {
          const barWidth = maxRankings > 0 ? (ranking.rankingsCount / maxRankings) * 100 : 0;
          const isFirst = i === 0;
          return (
            <div key={ranking.model} className="flex items-center gap-3">
              <span className={`w-5 text-right text-xs font-medium ${isFirst ? 'text-green-primary' : 'text-text-muted'}`}>
                #{i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs truncate ${isFirst ? 'text-green-primary font-medium' : 'text-text-primary'}`}>
                      {ranking.model}
                    </span>
                    {isFirst && (
                      <span className="text-[9px] bg-green-primary/20 text-green-primary px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wide">
                        Top
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-text-muted">
                    avg {ranking.averageRank.toFixed(2)} ({ranking.rankingsCount} votes)
                  </span>
                </div>
                <div className="h-1 bg-border-primary rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${isFirst ? 'bg-green-primary' : 'bg-text-muted'}`}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
