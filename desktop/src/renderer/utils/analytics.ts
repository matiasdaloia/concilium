import type { RunRecord, TokenUsage, ParsedEvent } from '../types';

// ─── Aggregated Types ────────────────────────────────────────────────────────

export interface ModelStats {
  model: string;
  runs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  averageTimeSeconds: number;
  wins: number;           // times ranked #1
  totalRankings: number;  // times ranked at all
  averageRank: number;
}

export interface CouncilModelStats {
  model: string;
  role: 'juror' | 'chairman';
  appearances: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalDurationSeconds: number;
  timedAppearances: number;
  averageDurationSeconds: number;
}

export interface RunTimelineEntry {
  id: string;
  date: string;           // ISO date (YYYY-MM-DD)
  createdAt: string;      // full ISO timestamp
  promptPreview: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  durationSeconds: number;
  agentCount: number;
  modelNames: string[];
  success: boolean;
}

export interface StageTimingStats {
  stage1AvgSeconds: number;
  stage2AvgSeconds: number;
  stage3AvgSeconds: number;
  totalAvgSeconds: number;
}

export interface CostByDate {
  date: string;
  cost: number;
  tokens: number;
}

export interface AnalyticsData {
  // Summary
  totalRuns: number;
  successfulRuns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  averageDurationSeconds: number;

  // By model
  modelStats: ModelStats[];

  // Council model stats (jurors + chairman)
  councilModelStats: CouncilModelStats[];

  // Timeline
  runTimeline: RunTimelineEntry[];

  // Cost over time
  costByDate: CostByDate[];

  // Stage timing
  stageTiming: StageTimingStats;

  // Provider distribution
  providerCounts: Record<string, number>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract final token usage from an agent's events array */
function extractTokenUsage(events: ParsedEvent[]): TokenUsage {
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalCost: null };

  for (const ev of events) {
    if (!ev.tokenUsage) continue;
    if (ev.tokenUsageCumulative) {
      // Cumulative: replace
      usage = { ...ev.tokenUsage };
    } else {
      // Incremental: sum
      const prevCost = usage.totalCost ?? 0;
      const evtCost = ev.tokenUsage.totalCost ?? 0;
      usage = {
        inputTokens: usage.inputTokens + ev.tokenUsage.inputTokens,
        outputTokens: usage.outputTokens + ev.tokenUsage.outputTokens,
        totalCost: (prevCost + evtCost) > 0 ? prevCost + evtCost : null,
      };
    }
  }

  return usage;
}

/** Calculate duration in seconds between two ISO timestamps */
function durationSeconds(startedAt?: string | null, endedAt?: string | null): number {
  if (!startedAt || !endedAt) return 0;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (isNaN(start) || isNaN(end)) return 0;
  return Math.max(0, (end - start) / 1000);
}

/** Get a short model name from a full agent name like "opencode · google/gemini-3-pro" */
function extractModelName(agentName: string): string {
  // Agent names are formatted as "provider · model/path" — use the full name
  return agentName;
}

// ─── Main Processing ─────────────────────────────────────────────────────────

export function processAnalytics(runs: RunRecord[]): AnalyticsData {
  const modelStatsMap = new Map<string, {
    runs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    totalTimeSeconds: number;
    timedRuns: number;
    wins: number;
    totalRankings: number;
    rankSum: number;
  }>();

  const providerCounts: Record<string, number> = {};
  const timeline: RunTimelineEntry[] = [];
  const costByDateMap = new Map<string, { cost: number; tokens: number }>();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let totalDuration = 0;
  let timedRunCount = 0;
  let successfulRuns = 0;

  // Stage timing accumulators
  let stage1TotalSeconds = 0;
  let stage1Count = 0;
  let stage2TotalSeconds = 0;
  let stage2Count = 0;
  let stage3TotalSeconds = 0;
  let stage3Count = 0;
  let totalRunSeconds = 0;
  let totalRunTimedCount = 0;

  // Council model stats accumulator
  const councilStatsMap = new Map<string, {
    role: 'juror' | 'chairman';
    appearances: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalDurationSeconds: number;
    timedAppearances: number;
  }>();

  for (const run of runs) {
    const isSuccess = run.agents.some(a => a.status === 'success');
    if (isSuccess) successfulRuns++;

    let runInputTokens = 0;
    let runOutputTokens = 0;
    let runCost = 0;
    let runDuration = 0;
    let runHasTiming = false;
    const modelNames: string[] = [];

    // Process each agent in the run
    for (const agent of run.agents) {
      const modelName = extractModelName(agent.name);
      modelNames.push(modelName);

      // Track provider
      const provider = agent.id;
      providerCounts[provider] = (providerCounts[provider] ?? 0) + 1;

      // Extract token usage from events
      const usage = extractTokenUsage(agent.events);
      const agentDuration = durationSeconds(agent.startedAt, agent.endedAt);

      runInputTokens += usage.inputTokens;
      runOutputTokens += usage.outputTokens;
      runCost += usage.totalCost ?? 0;

      if (agentDuration > 0) {
        runHasTiming = true;
        // For parallel agents, use the max duration
        runDuration = Math.max(runDuration, agentDuration);

        stage1TotalSeconds += agentDuration;
        stage1Count++;
      }

      // Update model stats
      const existing = modelStatsMap.get(modelName) ?? {
        runs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        totalTimeSeconds: 0,
        timedRuns: 0,
        wins: 0,
        totalRankings: 0,
        rankSum: 0,
      };

      existing.runs++;
      existing.totalInputTokens += usage.inputTokens;
      existing.totalOutputTokens += usage.outputTokens;
      existing.totalCost += usage.totalCost ?? 0;
      if (agentDuration > 0) {
        existing.totalTimeSeconds += agentDuration;
        existing.timedRuns++;
      }

      modelStatsMap.set(modelName, existing);
    }

    // Process rankings
    for (const ranking of run.metadata.aggregateRankings) {
      const stats = modelStatsMap.get(ranking.model);
      if (stats) {
        stats.totalRankings += ranking.rankingsCount;
        stats.rankSum += ranking.averageRank * ranking.rankingsCount;
      }
    }

    // Check for wins (first place)
    if (run.metadata.aggregateRankings.length > 0) {
      const winner = run.metadata.aggregateRankings[0];
      const winnerStats = modelStatsMap.get(winner.model);
      if (winnerStats) {
        winnerStats.wins++;
      }
    }

    // Process council model stats (jurors)
    for (const s2 of run.stage2) {
      const key = `juror:${s2.model}`;
      const existing = councilStatsMap.get(key) ?? {
        role: 'juror' as const,
        appearances: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalDurationSeconds: 0,
        timedAppearances: 0,
      };
      existing.appearances++;
      existing.totalPromptTokens += s2.usage?.promptTokens ?? 0;
      existing.totalCompletionTokens += s2.usage?.completionTokens ?? 0;
      const jurorDuration = durationSeconds(s2.startedAt, s2.endedAt);
      if (jurorDuration > 0) {
        existing.totalDurationSeconds += jurorDuration;
        existing.timedAppearances++;
        stage2TotalSeconds += jurorDuration;
        stage2Count++;
      }
      councilStatsMap.set(key, existing);
    }

    // Process council model stats (chairman)
    if (run.stage3) {
      const key = `chairman:${run.stage3.model}`;
      const existing = councilStatsMap.get(key) ?? {
        role: 'chairman' as const,
        appearances: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalDurationSeconds: 0,
        timedAppearances: 0,
      };
      existing.appearances++;
      existing.totalPromptTokens += run.stage3.usage?.promptTokens ?? 0;
      existing.totalCompletionTokens += run.stage3.usage?.completionTokens ?? 0;
      const chairmanDuration = durationSeconds(run.stage3.startedAt, run.stage3.endedAt);
      if (chairmanDuration > 0) {
        existing.totalDurationSeconds += chairmanDuration;
        existing.timedAppearances++;
        stage3TotalSeconds += chairmanDuration;
        stage3Count++;
      }
      councilStatsMap.set(key, existing);
    }

    // Accumulate totals
    totalInputTokens += runInputTokens;
    totalOutputTokens += runOutputTokens;
    totalCost += runCost;

    if (runHasTiming) {
      totalDuration += runDuration;
      timedRunCount++;
      totalRunSeconds += runDuration;
      totalRunTimedCount++;
    }

    // Timeline entry
    const date = run.createdAt.split('T')[0];
    timeline.push({
      id: run.id,
      date,
      createdAt: run.createdAt,
      promptPreview: run.prompt.slice(0, 80),
      totalInputTokens: runInputTokens,
      totalOutputTokens: runOutputTokens,
      totalCost: runCost,
      durationSeconds: runDuration,
      agentCount: run.agents.length,
      modelNames,
      success: isSuccess,
    });

    // Cost by date
    const dateEntry = costByDateMap.get(date) ?? { cost: 0, tokens: 0 };
    dateEntry.cost += runCost;
    dateEntry.tokens += runInputTokens + runOutputTokens;
    costByDateMap.set(date, dateEntry);
  }

  // Convert model stats map to sorted array
  const modelStats: ModelStats[] = [];
  for (const [model, stats] of modelStatsMap) {
    modelStats.push({
      model,
      runs: stats.runs,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
      totalCost: stats.totalCost,
      averageTimeSeconds: stats.timedRuns > 0 ? stats.totalTimeSeconds / stats.timedRuns : 0,
      wins: stats.wins,
      totalRankings: stats.totalRankings,
      averageRank: stats.totalRankings > 0 ? stats.rankSum / stats.totalRankings : 0,
    });
  }
  modelStats.sort((a, b) => b.runs - a.runs);

  // Convert cost by date map to sorted array
  const costByDate: CostByDate[] = [];
  for (const [date, entry] of costByDateMap) {
    costByDate.push({ date, ...entry });
  }
  costByDate.sort((a, b) => a.date.localeCompare(b.date));

  // Convert council stats map to sorted array
  const councilModelStats: CouncilModelStats[] = [];
  for (const [key, stats] of councilStatsMap) {
    const model = key.replace(/^(juror|chairman):/, '');
    councilModelStats.push({
      model,
      role: stats.role,
      appearances: stats.appearances,
      totalPromptTokens: stats.totalPromptTokens,
      totalCompletionTokens: stats.totalCompletionTokens,
      totalDurationSeconds: stats.totalDurationSeconds,
      timedAppearances: stats.timedAppearances,
      averageDurationSeconds: stats.timedAppearances > 0 ? stats.totalDurationSeconds / stats.timedAppearances : 0,
    });
  }
  councilModelStats.sort((a, b) => b.appearances - a.appearances);

  // Stage timing — use actual measurements when available, fall back to estimation
  const stage1Avg = stage1Count > 0 ? stage1TotalSeconds / stage1Count : 0;
  const stage2Avg = stage2Count > 0 ? stage2TotalSeconds / stage2Count : 0;
  const stage3Avg = stage3Count > 0 ? stage3TotalSeconds / stage3Count : 0;
  const totalAvg = totalRunTimedCount > 0 ? totalRunSeconds / totalRunTimedCount : 0;

  return {
    totalRuns: runs.length,
    successfulRuns,
    totalInputTokens,
    totalOutputTokens,
    totalCost,
    averageDurationSeconds: timedRunCount > 0 ? totalDuration / timedRunCount : 0,
    modelStats,
    councilModelStats,
    runTimeline: timeline,
    costByDate,
    stageTiming: {
      stage1AvgSeconds: stage1Avg,
      stage2AvgSeconds: stage2Avg,
      stage3AvgSeconds: stage3Avg,
      totalAvgSeconds: totalAvg,
    },
    providerCounts,
  };
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds === 0) return '—';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}m ${sec}s`;
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
