import React from 'react';
import { Text, Box } from 'ink';

interface JurorProgressProps {
  model: string;
  status: string;
  chunkCount?: number;
}

export function JurorProgress({ model, status, chunkCount }: JurorProgressProps) {
  const icon = status === 'complete' ? '✓' : status === 'failed' ? '✗' : status === 'evaluating' ? '▶' : '○';
  const color = status === 'complete' ? 'green' : status === 'failed' ? 'red' : status === 'evaluating' ? 'cyan' : 'gray';

  return (
    <Box>
      <Text color={color}>{icon} </Text>
      <Text>{model.padEnd(40)}</Text>
      <Text color={color}>{status}</Text>
      {chunkCount ? <Text color="gray"> ({chunkCount} chunks)</Text> : null}
    </Box>
  );
}
