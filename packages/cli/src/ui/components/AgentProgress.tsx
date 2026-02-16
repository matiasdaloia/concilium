import React from 'react';
import { Text, Box } from 'ink';
import { formatTokens, formatCost } from '../format.js';

interface AgentProgressProps {
  name: string;
  status: string;
  elapsed?: number;
  eventCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number | null;
}

export function AgentProgress({ name, status, elapsed, eventCount, inputTokens, outputTokens, totalCost }: AgentProgressProps) {
  const icon = status === 'success' ? '✓' : status === 'error' ? '✗' : status === 'running' ? '▶' : '○';
  const color = status === 'success' ? 'green' : status === 'error' ? 'red' : status === 'running' ? 'cyan' : 'gray';
  const elapsedStr = elapsed ? ` (${Math.round(elapsed / 1000)}s)` : '';
  const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);

  return (
    <Box>
      <Text color={color}>{icon} </Text>
      <Text>{name.padEnd(30)}</Text>
      <Text color={color}>{status}{elapsedStr}</Text>
      {totalTokens > 0 && <Text color="gray"> {formatTokens(totalTokens)}</Text>}
      {totalCost != null && totalCost > 0 && <Text color="gray"> {formatCost(totalCost)}</Text>}
    </Box>
  );
}
