import React from 'react';
import { Text, Box } from 'ink';
import type { CouncilTokenUsage } from '@concilium/core';
import { formatTokens, formatCost } from '../format.js';

interface JurorProgressProps {
  model: string;
  status: string;
  chunkCount?: number;
  usage?: CouncilTokenUsage;
  estimatedCost?: number | null;
}

export function JurorProgress({ model, status, chunkCount, usage, estimatedCost }: JurorProgressProps) {
  const icon = status === 'complete' ? '✓' : status === 'failed' ? '✗' : status === 'evaluating' ? '▶' : '○';
  const color = status === 'complete' ? 'green' : status === 'failed' ? 'red' : status === 'evaluating' ? 'cyan' : 'gray';

  return (
    <Box>
      <Text color={color}>{icon} </Text>
      <Text>{model.padEnd(40)}</Text>
      <Text color={color}>{status}</Text>
      {status === 'evaluating' && chunkCount ? <Text color="gray"> ({chunkCount} chunks)</Text> : null}
      {usage && <Text color="gray"> {formatTokens(usage.totalTokens)}</Text>}
      {estimatedCost != null && estimatedCost > 0 && <Text color="gray"> {formatCost(estimatedCost)}</Text>}
    </Box>
  );
}
