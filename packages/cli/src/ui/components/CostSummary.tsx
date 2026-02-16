import React from 'react';
import { Text, Box } from 'ink';
import type { RunRecord } from '@concilium/core';
import { formatTokens, formatCost } from '../format.js';

interface CostSummaryProps {
  record: RunRecord;
}

interface StageRow {
  label: string;
  tokens: number;
  cost: number | null;
}

function extractAgentTokens(record: RunRecord): StageRow[] {
  return record.agents.map((agent) => {
    let input = 0, output = 0;
    let cost: number | null = null;
    for (const ev of agent.events) {
      if (!ev.tokenUsage) continue;
      if (ev.tokenUsageCumulative) {
        input = ev.tokenUsage.inputTokens;
        output = ev.tokenUsage.outputTokens;
        cost = ev.tokenUsage.totalCost ?? null;
      } else {
        input += ev.tokenUsage.inputTokens;
        output += ev.tokenUsage.outputTokens;
        if (ev.tokenUsage.totalCost) cost = (cost ?? 0) + ev.tokenUsage.totalCost;
      }
    }
    return { label: agent.name, tokens: input + output, cost };
  });
}

export function CostSummary({ record }: CostSummaryProps) {
  const agentRows = extractAgentTokens(record);
  const jurorRows: StageRow[] = record.stage2.map((s) => ({
    label: s.model,
    tokens: s.usage?.totalTokens ?? 0,
    cost: s.estimatedCost ?? null,
  }));
  const chairmanRow: StageRow | null = record.stage3 ? {
    label: record.stage3.model,
    tokens: record.stage3.usage?.totalTokens ?? 0,
    cost: record.stage3.estimatedCost ?? null,
  } : null;

  const allRows = [...agentRows, ...jurorRows, ...(chairmanRow ? [chairmanRow] : [])];
  const totalTokens = allRows.reduce((sum, r) => sum + r.tokens, 0);
  const totalCost = allRows.reduce((sum, r) => sum + (r.cost ?? 0), 0);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">{'─'.repeat(60)}</Text>

      {/* Stage 1: Agents */}
      <Text bold> Agents</Text>
      {agentRows.map((row) => (
        <Box key={row.label}>
          <Text color="gray">  {row.label.padEnd(38)}</Text>
          <Text color="gray">{row.tokens > 0 ? formatTokens(row.tokens).padStart(10) : ''.padStart(10)}</Text>
          <Text color="gray">{row.cost != null && row.cost > 0 ? formatCost(row.cost).padStart(10) : ''.padStart(10)}</Text>
        </Box>
      ))}

      {/* Stage 2: Jurors */}
      {jurorRows.length > 0 && (
        <>
          <Text bold> Jurors</Text>
          {jurorRows.map((row) => (
            <Box key={row.label}>
              <Text color="gray">  {row.label.padEnd(38)}</Text>
              <Text color="gray">{row.tokens > 0 ? formatTokens(row.tokens).padStart(10) : ''.padStart(10)}</Text>
              <Text color="gray">{row.cost != null && row.cost > 0 ? formatCost(row.cost).padStart(10) : ''.padStart(10)}</Text>
            </Box>
          ))}
        </>
      )}

      {/* Stage 3: Chairman */}
      {chairmanRow && (
        <>
          <Text bold> Chairman</Text>
          <Box>
            <Text color="gray">  {chairmanRow.label.padEnd(38)}</Text>
            <Text color="gray">{chairmanRow.tokens > 0 ? formatTokens(chairmanRow.tokens).padStart(10) : ''.padStart(10)}</Text>
            <Text color="gray">{chairmanRow.cost != null && chairmanRow.cost > 0 ? formatCost(chairmanRow.cost).padStart(10) : ''.padStart(10)}</Text>
          </Box>
        </>
      )}

      {/* Totals */}
      <Text color="gray">{'─'.repeat(60)}</Text>
      <Box>
        <Text bold>  {'Total'.padEnd(38)}</Text>
        <Text bold>{totalTokens > 0 ? formatTokens(totalTokens).padStart(10) : ''.padStart(10)}</Text>
        <Text bold>{totalCost > 0 ? formatCost(totalCost).padStart(10) : ''.padStart(10)}</Text>
      </Box>
      <Text color="gray">  Run: {record.id}</Text>
    </Box>
  );
}
