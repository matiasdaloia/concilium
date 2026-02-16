import React from 'react';
import { Box, Text } from 'ink';
import type { DeliberationState } from './hooks/useDeliberation.js';
import { RunView } from './RunView.js';

interface AppProps {
  state: DeliberationState;
}

export function App({ state }: AppProps) {
  return (
    <Box flexDirection="column">
      <Box paddingX={2}>
        <Text bold color="cyan">Concilium</Text>
        <Text color="gray"> — Multi-LLM Deliberation</Text>
      </Box>
      <RunView state={state} />
    </Box>
  );
}
