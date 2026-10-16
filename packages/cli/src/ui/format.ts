/** Format a token count with k/M suffixes for readability. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k tok`;
  return `${count} tok`;
}

/**
 * Label for costs reported by an agent CLI (Claude Code `total_cost_usd`, OpenCode `cost`):
 * what the run would cost at API prices, not what a subscription bills.
 */
export const AGENT_COST_LABEL = 'est. API-equivalent';

/** Format a dollar cost, adjusting precision to the value magnitude. */
export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}
