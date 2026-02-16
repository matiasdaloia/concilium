import React from 'react';
import { Text, Box } from 'ink';
import { Spinner } from './Spinner.js';

interface StageIndicatorProps {
  currentStage: number;
  summary: string;
}

const STAGES = [
  { num: 1, label: 'Competing' },
  { num: 2, label: 'Judging' },
  { num: 3, label: 'Synthesizing' },
];

export function StageIndicator({ currentStage, summary }: StageIndicatorProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {STAGES.map((stage) => {
          const isActive = stage.num === currentStage;
          const isDone = stage.num < currentStage;
          const icon = isDone ? '✓' : isActive ? '▶' : '○';
          const color = isDone ? 'green' : isActive ? 'cyan' : 'gray';

          return (
            <Box key={stage.num} marginRight={2}>
              <Text color={color} bold={isActive}>
                {icon} {stage.label}
              </Text>
            </Box>
          );
        })}
      </Box>
      {currentStage > 0 && (
        <Box marginTop={1}>
          <Spinner text={summary} />
        </Box>
      )}
    </Box>
  );
}
