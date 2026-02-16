import React from 'react';
import { Text, Box } from 'ink';

interface SynthesisViewProps {
  text: string;
}

export function SynthesisView({ text }: SynthesisViewProps) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color="green">{'═'.repeat(60)}</Text>
      <Text bold color="green">  SYNTHESIS</Text>
      <Text bold color="green">{'═'.repeat(60)}</Text>
      <Box marginTop={1}>
        <Text>{text}</Text>
      </Box>
    </Box>
  );
}
