import React from 'react';
import { Text, Box } from 'ink';
import type { RunRecord } from '@concilium/core';

interface CostSummaryProps {
  record: RunRecord;
}

export function CostSummary({ record }: CostSummaryProps) {
  const stage2Costs = record.stage2.reduce((sum, r) => sum + (r.estimatedCost ?? 0), 0);
  const stage3Cost = record.stage3?.estimatedCost ?? 0;
  const totalCost = stage2Costs + stage3Cost;

  // Calculate total tokens from agent events
  let totalTokens = 0;
  for (const agent of record.agents) {
    for (const event of agent.events) {
      if (event.tokenUsage && event.tokenUsageCumulative) {
        totalTokens += event.tokenUsage.inputTokens + event.tokenUsage.outputTokens;
      }
    }
  }
  // Add council tokens
  for (const s of record.stage2) {
    if (s.usage) totalTokens += s.usage.totalTokens;
  }
  if (record.stage3?.usage) totalTokens += record.stage3.usage.totalTokens;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">{'─'.repeat(60)}</Text>
      <Text>
        {totalCost > 0 ? `  Cost: $${totalCost.toFixed(4)}` : ''}
        {totalTokens > 0 ? `  | Tokens: ${totalTokens.toLocaleString()}` : ''}
        {`  | Run: ${record.id}`}
      </Text>
    </Box>
  );
}
