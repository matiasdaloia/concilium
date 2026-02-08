import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import TitleBar from '../components/TitleBar';
import Button from '../components/Button';
import Badge from '../components/Badge';
import type { RunRecord } from '../types';
import {
  processAnalytics,
  formatTokenCount,
  formatCost,
  formatDuration,
  formatDate,
  type AnalyticsData,
  type ModelStats,
} from '../utils/analytics';

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color = 'text-text-primary' }: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-bg-surface border border-border-primary rounded-lg p-4">
      <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">{label}</div>
      <div className={`text-2xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-text-tertiary mt-1">{sub}</div>}
    </div>
  );
}

/** Horizontal bar with label, value, and visual bar */
function HBar({ label, value, maxValue, barColor, displayValue }: {
  label: string;
  value: number;
  maxValue: number;
  barColor: string;
  displayValue: string;
}) {
  const pct = maxValue > 0 ? (value / maxValue) * 100 : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-[11px] text-text-secondary font-mono truncate w-40 shrink-0" title={label}>
        {label}
      </span>
      <div className="flex-1 h-5 bg-border-primary/30 rounded overflow-hidden relative">
        <div
          className={`h-full rounded ${barColor} transition-all duration-500`}
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
        <span className="absolute right-2 top-0 h-full flex items-center text-[10px] font-mono text-text-primary">
          {displayValue}
        </span>
      </div>
    </div>
  );
}

/** Mini vertical bar chart (used for token usage grouped bars) */
function GroupedBarChart({ data, maxValue }: {
  data: Array<{ label: string; input: number; output: number }>;
  maxValue: number;
}) {
  if (data.length === 0) return <EmptyState message="No token data available" />;

  return (
    <div className="flex items-end gap-3 h-48 px-2">
      {data.map((d) => {
        const inputPct = maxValue > 0 ? (d.input / maxValue) * 100 : 0;
        const outputPct = maxValue > 0 ? (d.output / maxValue) * 100 : 0;
        return (
          <div key={d.label} className="flex-1 flex flex-col items-center gap-1 min-w-0">
            <div className="flex items-end gap-0.5 h-36 w-full justify-center">
              <div className="flex flex-col items-center justify-end h-full w-5">
                <div
                  className="w-full bg-blue-info/60 rounded-t transition-all duration-500"
                  style={{ height: `${Math.max(inputPct, 1)}%` }}
                  title={`Input: ${formatTokenCount(d.input)}`}
                />
              </div>
              <div className="flex flex-col items-center justify-end h-full w-5">
                <div
                  className="w-full bg-green-primary/60 rounded-t transition-all duration-500"
                  style={{ height: `${Math.max(outputPct, 1)}%` }}
                  title={`Output: ${formatTokenCount(d.output)}`}
                />
              </div>
            </div>
            <span className="text-[9px] text-text-muted font-mono truncate w-full text-center" title={d.label}>
              {d.label.length > 16 ? d.label.slice(0, 14) + '...' : d.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-32 text-text-muted text-xs font-mono">
      {message}
    </div>
  );
}

/** Stacked horizontal bar for stage timing */
function StageTimingBar({ timing }: { timing: AnalyticsData['stageTiming'] }) {
  const total = timing.totalAvgSeconds;
  if (total === 0) return <EmptyState message="No timing data available" />;

  const s1Pct = (timing.stage1AvgSeconds / total) * 100;
  const s2Pct = (timing.stage2AvgSeconds / total) * 100;

  return (
    <div className="space-y-3">
      <div className="h-8 rounded overflow-hidden flex">
        <div
          className="bg-blue-info/50 flex items-center justify-center text-[10px] font-mono text-white transition-all"
          style={{ width: `${s1Pct}%` }}
          title={`Stage 1 (Agents): ${formatDuration(timing.stage1AvgSeconds)}`}
        >
          {s1Pct > 15 ? 'Agents' : ''}
        </div>
        <div
          className="bg-amber-warning/50 flex items-center justify-center text-[10px] font-mono text-white transition-all"
          style={{ width: `${s2Pct}%` }}
          title={`Stage 2+3 (Council): ${formatDuration(timing.stage2AvgSeconds)}`}
        >
          {s2Pct > 15 ? 'Council' : ''}
        </div>
      </div>
      <div className="flex justify-between text-[10px] font-mono text-text-muted">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-blue-info/50" />
          Stage 1 — Agents: {formatDuration(timing.stage1AvgSeconds)}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-amber-warning/50" />
          Stage 2+3 — Council: {formatDuration(timing.stage2AvgSeconds)}
        </div>
        <div>
          Total: {formatDuration(timing.totalAvgSeconds)}
        </div>
      </div>
    </div>
  );
}

// ─── Tab types ───────────────────────────────────────────────────────────────

type AnalyticsTab = 'overview' | 'models' | 'costs' | 'performance' | 'history';

// ─── Main Component ──────────────────────────────────────────────────────────

interface AnalyticsScreenProps {
  onBack: () => void;
}

export default function AnalyticsScreen({ onBack }: AnalyticsScreenProps) {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [tab, setTab] = useState<AnalyticsTab>('overview');
  const [sortField, setSortField] = useState<'date' | 'tokens' | 'cost' | 'duration'>('date');
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    api.loadAllRuns().then((data) => {
      setRuns(data as RunRecord[]);
      setIsLoading(false);
    }).catch((err) => {
      console.error('Failed to load runs:', err);
      setIsLoading(false);
    });
  }, []);

  const analytics = useMemo(() => processAnalytics(runs), [runs]);

  const tabs: Array<{ id: AnalyticsTab; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'models', label: 'Models' },
    { id: 'costs', label: 'Costs' },
    { id: 'performance', label: 'Performance' },
    { id: 'history', label: 'Run History' },
  ];

  if (isLoading) {
    return (
      <div className="flex flex-col h-screen bg-bg-page overflow-hidden">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-text-muted">
            <div className="w-12 h-12 rounded-full border border-white/10 flex items-center justify-center animate-[spin-slow_3s_linear_infinite]">
              <div className="w-8 h-8 rounded-full border-t-2 border-green-primary" />
            </div>
            <span className="text-xs font-mono text-text-muted/70">Loading analytics...</span>
          </div>
        </div>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col h-screen bg-bg-page overflow-hidden">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-text-muted">
            <svg className="w-12 h-12 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <div className="text-center">
              <p className="text-sm font-mono text-text-secondary mb-1">No runs yet</p>
              <p className="text-xs font-mono text-text-muted">Complete some deliberation runs to see analytics</p>
            </div>
            <Button variant="primary" size="sm" onClick={onBack}>Back to Home</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-bg-page overflow-hidden">
      <TitleBar subtitle="analytics" />

      {/* Header */}
      <div className="px-6 py-3 flex items-center justify-between border-b border-border-primary shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-text-muted hover:text-text-secondary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h2 className="text-sm font-bold font-mono text-text-primary tracking-tight">Analytics</h2>
          <Badge variant="muted">{analytics.totalRuns} runs</Badge>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-6 flex items-center border-b border-border-primary shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-xs border-b-2 transition-colors
              ${tab === t.id
                ? 'border-green-primary text-green-primary'
                : 'border-transparent text-text-muted hover:text-text-secondary'
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'overview' && <OverviewTab analytics={analytics} />}
        {tab === 'models' && <ModelsTab analytics={analytics} />}
        {tab === 'costs' && <CostsTab analytics={analytics} />}
        {tab === 'performance' && <PerformanceTab analytics={analytics} />}
        {tab === 'history' && (
          <HistoryTab
            analytics={analytics}
            sortField={sortField}
            sortAsc={sortAsc}
            onSort={(field) => {
              if (field === sortField) {
                setSortAsc(!sortAsc);
              } else {
                setSortField(field);
                setSortAsc(false);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Tab: Overview ───────────────────────────────────────────────────────────

function OverviewTab({ analytics }: { analytics: AnalyticsData }) {
  const successRate = analytics.totalRuns > 0
    ? ((analytics.successfulRuns / analytics.totalRuns) * 100).toFixed(0)
    : '0';

  return (
    <div className="p-6 space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard
          label="Total Runs"
          value={String(analytics.totalRuns)}
          sub={`${successRate}% success rate`}
          color="text-green-primary"
        />
        <StatCard
          label="Total Tokens"
          value={formatTokenCount(analytics.totalInputTokens + analytics.totalOutputTokens)}
          sub={`${formatTokenCount(analytics.totalInputTokens)} in · ${formatTokenCount(analytics.totalOutputTokens)} out`}
        />
        <StatCard
          label="Total Cost"
          value={formatCost(analytics.totalCost)}
          sub={analytics.totalRuns > 0 ? `${formatCost(analytics.totalCost / analytics.totalRuns)} avg/run` : undefined}
          color="text-amber-warning"
        />
        <StatCard
          label="Avg Duration"
          value={formatDuration(analytics.averageDurationSeconds)}
          sub="per run (Stage 1)"
        />
        <StatCard
          label="Models Used"
          value={String(analytics.modelStats.length)}
          sub={`${Object.keys(analytics.providerCounts).length} providers`}
          color="text-blue-info"
        />
      </div>

      {/* Token Usage by Model */}
      <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
        <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Token Usage by Model</h3>
        <p className="text-[10px] text-text-muted mb-4">Input (blue) vs Output (green) tokens per model</p>
        <GroupedBarChart
          data={analytics.modelStats.map(s => ({
            label: s.model,
            input: s.totalInputTokens,
            output: s.totalOutputTokens,
          }))}
          maxValue={Math.max(...analytics.modelStats.map(s => Math.max(s.totalInputTokens, s.totalOutputTokens)), 1)}
        />
        <div className="flex items-center gap-4 mt-3 pt-3 border-t border-border-primary">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-text-muted">
            <span className="w-2 h-2 rounded-sm bg-blue-info/60" /> Input tokens
          </div>
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-text-muted">
            <span className="w-2 h-2 rounded-sm bg-green-primary/60" /> Output tokens
          </div>
        </div>
      </div>

      {/* Average Stage Timing */}
      <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
        <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Average Stage Timing</h3>
        <p className="text-[10px] text-text-muted mb-4">Time distribution across pipeline stages</p>
        <StageTimingBar timing={analytics.stageTiming} />
      </div>
    </div>
  );
}

// ─── Tab: Models ─────────────────────────────────────────────────────────────

function ModelsTab({ analytics }: { analytics: AnalyticsData }) {
  const maxTokens = Math.max(...analytics.modelStats.map(s => s.totalInputTokens + s.totalOutputTokens), 1);
  const maxTime = Math.max(...analytics.modelStats.map(s => s.averageTimeSeconds), 1);

  return (
    <div className="p-6 space-y-6">
      {/* Model Comparison Table */}
      <div className="bg-bg-surface border border-border-primary rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border-primary">
          <h3 className="text-xs font-medium text-text-secondary tracking-wide">Model Comparison</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="border-b border-border-primary text-text-muted">
                <th className="text-left px-5 py-2.5 font-medium">Model</th>
                <th className="text-right px-3 py-2.5 font-medium">Runs</th>
                <th className="text-right px-3 py-2.5 font-medium">Input Tokens</th>
                <th className="text-right px-3 py-2.5 font-medium">Output Tokens</th>
                <th className="text-right px-3 py-2.5 font-medium">Total Cost</th>
                <th className="text-right px-3 py-2.5 font-medium">Avg Time</th>
                <th className="text-right px-5 py-2.5 font-medium">Avg Rank</th>
              </tr>
            </thead>
            <tbody>
              {analytics.modelStats.map((s, i) => (
                <tr key={s.model} className={`border-b border-border-primary/50 ${i % 2 === 0 ? 'bg-bg-surface' : 'bg-bg-page/30'}`}>
                  <td className="px-5 py-2.5 text-text-primary font-medium truncate max-w-[200px]" title={s.model}>
                    {s.model}
                  </td>
                  <td className="text-right px-3 py-2.5 text-text-secondary">{s.runs}</td>
                  <td className="text-right px-3 py-2.5 text-blue-info">{formatTokenCount(s.totalInputTokens)}</td>
                  <td className="text-right px-3 py-2.5 text-green-primary">{formatTokenCount(s.totalOutputTokens)}</td>
                  <td className="text-right px-3 py-2.5 text-amber-warning">{formatCost(s.totalCost)}</td>
                  <td className="text-right px-3 py-2.5 text-text-secondary">{formatDuration(s.averageTimeSeconds)}</td>
                  <td className="text-right px-5 py-2.5 text-text-secondary">
                    {s.averageRank > 0 ? s.averageRank.toFixed(2) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Total Tokens per Model */}
      <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
        <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Total Tokens per Model</h3>
        <p className="text-[10px] text-text-muted mb-3">Combined input + output tokens</p>
        <div className="space-y-0.5">
          {analytics.modelStats.map((s) => (
            <HBar
              key={s.model}
              label={s.model}
              value={s.totalInputTokens + s.totalOutputTokens}
              maxValue={maxTokens}
              barColor="bg-blue-info/40"
              displayValue={formatTokenCount(s.totalInputTokens + s.totalOutputTokens)}
            />
          ))}
        </div>
      </div>

      {/* Average Execution Time per Model */}
      <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
        <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Average Execution Time</h3>
        <p className="text-[10px] text-text-muted mb-3">Stage 1 agent completion time</p>
        <div className="space-y-0.5">
          {analytics.modelStats
            .filter(s => s.averageTimeSeconds > 0)
            .sort((a, b) => a.averageTimeSeconds - b.averageTimeSeconds)
            .map((s) => (
              <HBar
                key={s.model}
                label={s.model}
                value={s.averageTimeSeconds}
                maxValue={maxTime}
                barColor="bg-amber-warning/40"
                displayValue={formatDuration(s.averageTimeSeconds)}
              />
            ))}
        </div>
      </div>
    </div>
  );
}

// ─── Tab: Costs ──────────────────────────────────────────────────────────────

function CostsTab({ analytics }: { analytics: AnalyticsData }) {
  const maxModelCost = Math.max(...analytics.modelStats.map(s => s.totalCost), 0.001);
  const maxDateCost = Math.max(...analytics.costByDate.map(d => d.cost), 0.001);

  // Calculate cost per 1k tokens for each model
  const costEfficiency = analytics.modelStats
    .filter(s => s.totalCost > 0)
    .map(s => ({
      model: s.model,
      costPer1k: (s.totalCost / ((s.totalInputTokens + s.totalOutputTokens) / 1000)) || 0,
      totalCost: s.totalCost,
    }))
    .sort((a, b) => a.costPer1k - b.costPer1k);

  const maxCostPer1k = Math.max(...costEfficiency.map(c => c.costPer1k), 0.001);

  return (
    <div className="p-6 space-y-6">
      {/* Cost Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Total Spend"
          value={formatCost(analytics.totalCost)}
          color="text-amber-warning"
        />
        <StatCard
          label="Avg Cost / Run"
          value={analytics.totalRuns > 0 ? formatCost(analytics.totalCost / analytics.totalRuns) : '$0.00'}
        />
        <StatCard
          label="Cost / 1k Tokens"
          value={analytics.totalInputTokens + analytics.totalOutputTokens > 0
            ? formatCost(analytics.totalCost / ((analytics.totalInputTokens + analytics.totalOutputTokens) / 1000))
            : '$0.00'}
          sub="blended average"
        />
        <StatCard
          label="Most Expensive Model"
          value={analytics.modelStats.length > 0
            ? analytics.modelStats.reduce((a, b) => a.totalCost > b.totalCost ? a : b).model.split(' · ').pop() ?? '—'
            : '—'}
          sub={analytics.modelStats.length > 0
            ? formatCost(Math.max(...analytics.modelStats.map(s => s.totalCost)))
            : undefined}
        />
      </div>

      {/* Cost per Model */}
      <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
        <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Cost per Model</h3>
        <p className="text-[10px] text-text-muted mb-3">Total accumulated cost</p>
        <div className="space-y-0.5">
          {analytics.modelStats
            .filter(s => s.totalCost > 0)
            .sort((a, b) => b.totalCost - a.totalCost)
            .map((s) => (
              <HBar
                key={s.model}
                label={s.model}
                value={s.totalCost}
                maxValue={maxModelCost}
                barColor="bg-amber-warning/40"
                displayValue={formatCost(s.totalCost)}
              />
            ))}
          {analytics.modelStats.every(s => s.totalCost === 0) && (
            <EmptyState message="No cost data available" />
          )}
        </div>
      </div>

      {/* Cost Efficiency */}
      {costEfficiency.length > 0 && (
        <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
          <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Cost Efficiency</h3>
          <p className="text-[10px] text-text-muted mb-3">Cost per 1,000 tokens — lower is better</p>
          <div className="space-y-0.5">
            {costEfficiency.map((c) => (
              <HBar
                key={c.model}
                label={c.model}
                value={c.costPer1k}
                maxValue={maxCostPer1k}
                barColor="bg-green-primary/40"
                displayValue={formatCost(c.costPer1k)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Spend Over Time */}
      {analytics.costByDate.length > 1 && (
        <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
          <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Spend Over Time</h3>
          <p className="text-[10px] text-text-muted mb-3">Daily cost breakdown</p>
          <div className="space-y-0.5">
            {analytics.costByDate.map((d) => (
              <HBar
                key={d.date}
                label={formatDate(d.date)}
                value={d.cost}
                maxValue={maxDateCost}
                barColor="bg-amber-warning/40"
                displayValue={formatCost(d.cost)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tab: Performance ────────────────────────────────────────────────────────

function PerformanceTab({ analytics }: { analytics: AnalyticsData }) {
  const modelsWithWins = analytics.modelStats.filter(s => s.totalRankings > 0);
  const maxWins = Math.max(...modelsWithWins.map(s => s.wins), 1);
  const totalWinnableRuns = analytics.runTimeline.filter(r => r.success).length;

  // Win rate calculation
  const winRates = modelsWithWins
    .map(s => ({
      model: s.model,
      wins: s.wins,
      winRate: totalWinnableRuns > 0 ? (s.wins / s.runs) * 100 : 0,
      avgRank: s.averageRank,
      runs: s.runs,
    }))
    .sort((a, b) => b.winRate - a.winRate);

  const maxWinRate = Math.max(...winRates.map(w => w.winRate), 1);

  // Efficiency score: quality per dollar (inverse rank / cost)
  const efficiencyScores = analytics.modelStats
    .filter(s => s.averageRank > 0 && s.totalCost > 0)
    .map(s => {
      // Lower rank = better, lower cost = better
      // Score = runs / (averageRank * costPerRun)
      const costPerRun = s.totalCost / s.runs;
      const score = 1 / (s.averageRank * costPerRun);
      return { model: s.model, score, avgRank: s.averageRank, costPerRun };
    })
    .sort((a, b) => b.score - a.score);

  const maxEfficiency = Math.max(...efficiencyScores.map(e => e.score), 0.001);

  return (
    <div className="p-6 space-y-6">
      {/* Win Rate */}
      <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
        <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Win Rate</h3>
        <p className="text-[10px] text-text-muted mb-3">Percentage of runs where model was ranked #1 by jurors</p>
        {winRates.length > 0 ? (
          <div className="space-y-0.5">
            {winRates.map((w) => (
              <HBar
                key={w.model}
                label={w.model}
                value={w.winRate}
                maxValue={maxWinRate}
                barColor="bg-green-primary/40"
                displayValue={`${w.winRate.toFixed(0)}% (${w.wins}/${w.runs})`}
              />
            ))}
          </div>
        ) : (
          <EmptyState message="No ranking data available yet" />
        )}
      </div>

      {/* Total Wins */}
      <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
        <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Total #1 Rankings</h3>
        <p className="text-[10px] text-text-muted mb-3">Number of times each model was ranked first</p>
        {modelsWithWins.length > 0 ? (
          <div className="space-y-0.5">
            {modelsWithWins
              .sort((a, b) => b.wins - a.wins)
              .map((s) => (
                <HBar
                  key={s.model}
                  label={s.model}
                  value={s.wins}
                  maxValue={maxWins}
                  barColor="bg-green-primary/40"
                  displayValue={`${s.wins} wins`}
                />
              ))}
          </div>
        ) : (
          <EmptyState message="No ranking data available yet" />
        )}
      </div>

      {/* Average Ranking */}
      <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
        <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Average Ranking</h3>
        <p className="text-[10px] text-text-muted mb-3">Lower is better — averaged across all juror evaluations</p>
        {modelsWithWins.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="border-b border-border-primary text-text-muted">
                  <th className="text-left px-4 py-2 font-medium">Model</th>
                  <th className="text-right px-4 py-2 font-medium">Avg Rank</th>
                  <th className="text-right px-4 py-2 font-medium">Times Ranked</th>
                  <th className="text-right px-4 py-2 font-medium">Wins</th>
                  <th className="text-left px-4 py-2 font-medium">Distribution</th>
                </tr>
              </thead>
              <tbody>
                {modelsWithWins
                  .sort((a, b) => a.averageRank - b.averageRank)
                  .map((s, i) => {
                    const maxRank = Math.max(...modelsWithWins.map(m => m.averageRank));
                    const barPct = maxRank > 0 ? ((maxRank - s.averageRank + 1) / (maxRank + 1)) * 100 : 0;
                    return (
                      <tr key={s.model} className="border-b border-border-primary/50">
                        <td className="px-4 py-2 text-text-primary truncate max-w-[200px]">
                          <span className="flex items-center gap-2">
                            <span className={`text-[10px] ${i === 0 ? 'text-green-primary' : 'text-text-muted'}`}>#{i + 1}</span>
                            {s.model}
                          </span>
                        </td>
                        <td className="text-right px-4 py-2 text-text-secondary">{s.averageRank.toFixed(2)}</td>
                        <td className="text-right px-4 py-2 text-text-muted">{s.totalRankings}</td>
                        <td className="text-right px-4 py-2 text-green-primary">{s.wins}</td>
                        <td className="px-4 py-2">
                          <div className="h-2 bg-border-primary/30 rounded-full overflow-hidden w-24">
                            <div
                              className={`h-full rounded-full ${i === 0 ? 'bg-green-primary/60' : 'bg-blue-info/40'}`}
                              style={{ width: `${barPct}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState message="No ranking data available yet" />
        )}
      </div>

      {/* Quality per Dollar (Efficiency) */}
      {efficiencyScores.length > 0 && (
        <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
          <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Quality/Cost Efficiency</h3>
          <p className="text-[10px] text-text-muted mb-3">
            Higher is better — models that rank well while costing less score higher
          </p>
          <div className="space-y-0.5">
            {efficiencyScores.map((e) => (
              <HBar
                key={e.model}
                label={e.model}
                value={e.score}
                maxValue={maxEfficiency}
                barColor="bg-provider-claude/40"
                displayValue={`rank ${e.avgRank.toFixed(1)} · ${formatCost(e.costPerRun)}/run`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tab: History ────────────────────────────────────────────────────────────

function HistoryTab({ analytics, sortField, sortAsc, onSort }: {
  analytics: AnalyticsData;
  sortField: string;
  sortAsc: boolean;
  onSort: (field: 'date' | 'tokens' | 'cost' | 'duration') => void;
}) {
  const sorted = useMemo(() => {
    const entries = [...analytics.runTimeline];
    const dir = sortAsc ? 1 : -1;
    switch (sortField) {
      case 'date':
        entries.sort((a, b) => dir * a.createdAt.localeCompare(b.createdAt));
        break;
      case 'tokens':
        entries.sort((a, b) => dir * ((a.totalInputTokens + a.totalOutputTokens) - (b.totalInputTokens + b.totalOutputTokens)));
        break;
      case 'cost':
        entries.sort((a, b) => dir * (a.totalCost - b.totalCost));
        break;
      case 'duration':
        entries.sort((a, b) => dir * (a.durationSeconds - b.durationSeconds));
        break;
    }
    return entries;
  }, [analytics.runTimeline, sortField, sortAsc]);

  const SortHeader = ({ field, children }: { field: 'date' | 'tokens' | 'cost' | 'duration'; children: React.ReactNode }) => (
    <th
      className="px-3 py-2.5 font-medium cursor-pointer hover:text-text-secondary transition-colors select-none"
      onClick={() => onSort(field)}
    >
      <span className="flex items-center gap-1 justify-end">
        {children}
        {sortField === field && (
          <svg className={`w-3 h-3 transition-transform ${sortAsc ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        )}
      </span>
    </th>
  );

  return (
    <div className="p-6">
      <div className="bg-bg-surface border border-border-primary rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border-primary flex items-center justify-between">
          <h3 className="text-xs font-medium text-text-secondary tracking-wide">Run History</h3>
          <span className="text-[10px] text-text-muted font-mono">{sorted.length} runs</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="border-b border-border-primary text-text-muted text-right">
                <th className="text-left px-5 py-2.5 font-medium w-12">Status</th>
                <SortHeader field="date">Date</SortHeader>
                <th className="text-left px-3 py-2.5 font-medium">Prompt</th>
                <th className="text-center px-3 py-2.5 font-medium">Models</th>
                <SortHeader field="tokens">Tokens</SortHeader>
                <SortHeader field="cost">Cost</SortHeader>
                <SortHeader field="duration">Duration</SortHeader>
              </tr>
            </thead>
            <tbody>
              {sorted.map((run, i) => (
                <tr key={run.id} className={`border-b border-border-primary/50 ${i % 2 === 0 ? '' : 'bg-bg-page/30'}`}>
                  <td className="px-5 py-2">
                    {run.success ? (
                      <span className="w-2 h-2 rounded-full bg-green-primary inline-block" />
                    ) : (
                      <span className="w-2 h-2 rounded-full bg-red-error inline-block" />
                    )}
                  </td>
                  <td className="text-right px-3 py-2 text-text-muted whitespace-nowrap">
                    {new Date(run.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="text-left px-3 py-2 text-text-secondary truncate max-w-[250px]" title={run.promptPreview}>
                    {run.promptPreview}
                  </td>
                  <td className="text-center px-3 py-2">
                    <span className="text-text-muted">{run.agentCount}</span>
                  </td>
                  <td className="text-right px-3 py-2 text-blue-info">
                    {formatTokenCount(run.totalInputTokens + run.totalOutputTokens)}
                  </td>
                  <td className="text-right px-3 py-2 text-amber-warning">
                    {run.totalCost > 0 ? formatCost(run.totalCost) : '—'}
                  </td>
                  <td className="text-right px-3 py-2 text-text-secondary">
                    {formatDuration(run.durationSeconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
