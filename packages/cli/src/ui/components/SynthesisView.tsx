import React, { useMemo } from 'react';
import { Text, Box } from 'ink';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

marked.use(markedTerminal());

interface SynthesisViewProps {
  text: string;
}

export function SynthesisView({ text }: SynthesisViewProps) {
  const rendered = useMemo(() => {
    const output = marked(text) as string;
    // marked-terminal adds a trailing newline; trim for clean layout
    return output.trimEnd();
  }, [text]);

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color="green">{'═'.repeat(60)}</Text>
      <Text bold color="green">  SYNTHESIS</Text>
      <Text bold color="green">{'═'.repeat(60)}</Text>
      <Box marginTop={1}>
        <Text>{rendered}</Text>
      </Box>
    </Box>
  );
}
