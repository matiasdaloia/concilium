import React from 'react';
import { Text, Box } from 'ink';

interface AgentProgressProps {
  name: string;
  status: string;
  elapsed?: number;
  eventCount?: number;
}

export function AgentProgress({ name, status, elapsed, eventCount }: AgentProgressProps) {
  const icon = status === 'success' ? '✓' : status === 'error' ? '✗' : status === 'running' ? '▶' : '○';
  const color = status === 'success' ? 'green' : status === 'error' ? 'red' : status === 'running' ? 'cyan' : 'gray';
  const elapsedStr = elapsed ? ` (${Math.round(elapsed / 1000)}s)` : '';

  return (
    <Box>
      <Text color={color}>{icon} </Text>
      <Text>{name.padEnd(30)}</Text>
      <Text color={color}>{status}{elapsedStr}</Text>
      {eventCount ? <Text color="gray"> ({eventCount} events)</Text> : null}
    </Box>
  );
}
