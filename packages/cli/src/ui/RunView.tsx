import React from 'react';
import { Box, Text } from 'ink';
import type { DeliberationState } from './hooks/useDeliberation.js';
import { StageIndicator } from './components/StageIndicator.js';
import { AgentProgress } from './components/AgentProgress.js';
import { JurorProgress } from './components/JurorProgress.js';
import { Leaderboard } from './components/Leaderboard.js';
import { SynthesisView } from './components/SynthesisView.js';
import { CostSummary } from './components/CostSummary.js';

interface RunViewProps {
  state: DeliberationState;
}

export function RunView({ state }: RunViewProps) {
  // Build a map of juror model → estimatedCost from the record (available at completion)
  const jurorCosts = new Map<string, number>();
  if (state.record) {
    for (const s of state.record.stage2) {
      if (s.estimatedCost != null) jurorCosts.set(s.model, s.estimatedCost);
    }
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <StageIndicator currentStage={state.stage} summary={state.stageSummary} />

      {state.stage >= 1 && (
        <Box flexDirection="column" marginBottom={1}>
          {Array.from(state.agents.values()).map((agent) => (
            <AgentProgress
              key={agent.key}
              name={agent.name}
              status={agent.status}
              elapsed={agent.startedAt ? Date.now() - agent.startedAt : undefined}
              eventCount={agent.eventCount}
              inputTokens={agent.inputTokens}
              outputTokens={agent.outputTokens}
              totalCost={agent.totalCost}
            />
          ))}
        </Box>
      )}

      {state.stage >= 2 && state.jurors.size > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="yellow">Jurors:</Text>
          {Array.from(state.jurors.values()).map((juror) => (
            <JurorProgress
              key={juror.model}
              model={juror.model}
              status={juror.status}
              chunkCount={juror.chunkCount}
              usage={juror.usage}
              estimatedCost={jurorCosts.get(juror.model)}
            />
          ))}
        </Box>
      )}

      {state.rankings.length > 0 && <Leaderboard rankings={state.rankings} />}

      {state.record?.stage3?.response && (
        <SynthesisView text={state.record.stage3.response} />
      )}

      {state.record && <CostSummary record={state.record} />}

      {state.error && (
        <Box marginTop={1}>
          <Text color="red" bold>Error: {state.error}</Text>
        </Box>
      )}
    </Box>
  );
}
