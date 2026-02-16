import React from 'react';
import { Text, Box } from 'ink';
import type { AggregateRanking } from '@concilium/core';

interface LeaderboardProps {
  rankings: AggregateRanking[];
}

export function Leaderboard({ rankings }: LeaderboardProps) {
  if (rankings.length === 0) return null;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color="yellow">Rankings:</Text>
      {rankings.map((r, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return (
          <Box key={r.model}>
            <Text>  {medal} </Text>
            <Text bold>{r.model}</Text>
            <Text color="gray"> ({r.averageRank.toFixed(2)})</Text>
          </Box>
        );
      })}
    </Box>
  );
}
