import { useState, useEffect, useRef } from 'react';

// ─── Sample data (mirrors what the real app computes) ─────────────────────────

const MODELS = [
  {
    name: 'claude · anthropic/claude-sonnet-4',
    color: '#A855F7',
    inputTokens: 31400,
    outputTokens: 16800,
    cost: 1.24,
    wins: 14,
    runs: 20,
    totalRankings: 58,
    avgRank: 1.31,
    avgTime: 42,
  },
  {
    name: 'opencode · google/gemini-2.5-pro',
    color: '#22C55E',
    inputTokens: 22100,
    outputTokens: 13700,
    cost: 0.87,
    wins: 11,
    runs: 20,
    totalRankings: 58,
    avgRank: 1.72,
    avgTime: 38,
  },
  {
    name: 'codex · openai/o3',
    color: '#3B82F6',
    inputTokens: 28300,
    outputTokens: 13200,
    cost: 1.05,
    wins: 8,
    runs: 20,
    totalRankings: 58,
    avgRank: 1.97,
    avgTime: 55,
  },
];

const COST_BY_DATE = [
  { date: 'Jan 28', cost: 0.42 },
  { date: 'Jan 29', cost: 0.71 },
  { date: 'Jan 30', cost: 0.38 },
  { date: 'Jan 31', cost: 0.95 },
  { date: 'Feb 01', cost: 0.54 },
  { date: 'Feb 02', cost: 0.16 },
];

const RUN_HISTORY = [
  { status: true, date: 'Feb 2, 10:14am', prompt: 'Add JWT auth middleware with refresh token rotation', agents: 3, tokens: 14200, cost: 0.16, duration: 58 },
  { status: true, date: 'Feb 1, 3:42pm', prompt: 'Refactor database connection pool to use singleton pattern', agents: 3, tokens: 18500, cost: 0.21, duration: 72 },
  { status: true, date: 'Feb 1, 11:08am', prompt: 'Fix race condition in WebSocket message handler', agents: 3, tokens: 12800, cost: 0.14, duration: 45 },
  { status: false, date: 'Jan 31, 4:55pm', prompt: 'Implement Redis caching layer for API responses', agents: 2, tokens: 8900, cost: 0.10, duration: 38 },
  { status: true, date: 'Jan 31, 2:20pm', prompt: 'Add comprehensive error handling to payment flow', agents: 3, tokens: 21400, cost: 0.24, duration: 85 },
  { status: true, date: 'Jan 31, 9:15am', prompt: 'Create migration script for user preferences schema', agents: 3, tokens: 16700, cost: 0.19, duration: 62 },
];

const TABS = ['Overview', 'Models', 'Costs', 'Performance', 'Run History'] as const;
type Tab = (typeof TABS)[number];

// ─── Animated number ──────────────────────────────────────────────────────────

function AnimatedNumber({ value, prefix = '', suffix = '', decimals = 0 }: {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
}) {
  const [displayed, setDisplayed] = useState(0);
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (hasAnimated.current) return;
    hasAnimated.current = true;
    const duration = 1200;
    const start = performance.now();
    function tick(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayed(eased * value);
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }, [value]);

  return <span>{prefix}{displayed.toFixed(decimals)}{suffix}</span>;
}

// ─── Reusable components ──────────────────────────────────────────────────────

function StatCard({ label, children, sub, color = 'text-[#e5e5e5]' }: {
  label: string;
  children: React.ReactNode;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
      <div className="text-[10px] text-[#404040] uppercase tracking-wider font-mono mb-2">{label}</div>
      <div className={`text-xl font-bold font-mono ${color}`}>{children}</div>
      {sub && <div className="text-[10px] text-[#525252] mt-1 font-mono">{sub}</div>}
    </div>
  );
}

function HBar({ label, value, maxValue, color, displayValue }: {
  label: string;
  value: number;
  maxValue: number;
  color: string;
  displayValue: string;
}) {
  const pct = maxValue > 0 ? (value / maxValue) * 100 : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-[11px] text-[#a3a3a3] font-mono w-40 shrink-0 truncate" title={label}>{label}</span>
      <div className="flex-1 h-5 bg-[#1a1a1a] rounded overflow-hidden relative">
        <div
          className="h-full rounded transition-all duration-700 ease-out"
          style={{ width: `${Math.max(pct, 1)}%`, backgroundColor: color }}
        />
        <span className="absolute right-2 top-0 h-full flex items-center text-[10px] font-mono text-[#e5e5e5]">
          {displayValue}
        </span>
      </div>
    </div>
  );
}

/** Grouped vertical bar chart — input vs output tokens per model (mirrors app's GroupedBarChart) */
function GroupedBarChart() {
  const maxVal = Math.max(...MODELS.flatMap((m) => [m.inputTokens, m.outputTokens]));
  return (
    <div className="flex items-end gap-6 h-40 px-2 justify-center">
      {MODELS.map((m) => {
        const inPct = maxVal > 0 ? (m.inputTokens / maxVal) * 100 : 0;
        const outPct = maxVal > 0 ? (m.outputTokens / maxVal) * 100 : 0;
        return (
          <div key={m.name} className="flex flex-col items-center gap-1">
            <div className="flex items-end gap-1 h-28">
              <div className="flex flex-col justify-end h-full w-5">
                <div
                  className="w-full rounded-t transition-all duration-700"
                  style={{ height: `${Math.max(inPct, 2)}%`, backgroundColor: '#3B82F6', opacity: 0.6 }}
                  title={`Input: ${(m.inputTokens / 1000).toFixed(1)}k`}
                />
              </div>
              <div className="flex flex-col justify-end h-full w-5">
                <div
                  className="w-full rounded-t transition-all duration-700"
                  style={{ height: `${Math.max(outPct, 2)}%`, backgroundColor: '#22C55E', opacity: 0.6 }}
                  title={`Output: ${(m.outputTokens / 1000).toFixed(1)}k`}
                />
              </div>
            </div>
            <span className="text-[8px] text-[#404040] font-mono truncate max-w-[80px] text-center">
              {m.name.split(' · ')[0]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Tab: Overview (mirrors app's OverviewTab) ────────────────────────────────

function OverviewTab() {
  const totalInput = MODELS.reduce((s, m) => s + m.inputTokens, 0);
  const totalOutput = MODELS.reduce((s, m) => s + m.outputTokens, 0);
  const totalCost = MODELS.reduce((s, m) => s + m.cost, 0);
  const successRate = 95;
  const avgDuration = 58;

  return (
    <div className="space-y-4">
      {/* Summary cards — matches app's 5-card grid */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Total Runs" color="text-[#22C55E]" sub={`${successRate}% success rate`}>
          <AnimatedNumber value={20} decimals={0} />
        </StatCard>
        <StatCard label="Total Tokens" sub={`${(totalInput / 1000).toFixed(1)}k in · ${(totalOutput / 1000).toFixed(1)}k out`}>
          <AnimatedNumber value={(totalInput + totalOutput) / 1000} suffix="k" decimals={1} />
        </StatCard>
        <StatCard label="Total Cost" color="text-[#F59E0B]" sub={`$${(totalCost / 20).toFixed(3)} avg/run`}>
          <AnimatedNumber value={totalCost} prefix="$" decimals={2} />
        </StatCard>
        <StatCard label="Avg Duration" sub="per run (Stage 1)">
          <AnimatedNumber value={avgDuration} suffix="s" decimals={1} />
        </StatCard>
        <StatCard label="Models Used" color="text-[#3B82F6]" sub="3 providers">
          3
        </StatCard>
      </div>

      {/* Token Usage by Model — grouped bar chart matching app */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#a3a3a3] font-mono mb-1">Token Usage by Model</div>
        <div className="text-[9px] text-[#404040] font-mono mb-3">Input (blue) vs Output (green) tokens per model</div>
        <GroupedBarChart />
        <div className="flex items-center gap-4 mt-3 pt-3 border-t border-[#1f1f1f]">
          <div className="flex items-center gap-1.5 text-[9px] text-[#404040] font-mono">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#3B82F6', opacity: 0.6 }} /> Input tokens
          </div>
          <div className="flex items-center gap-1.5 text-[9px] text-[#404040] font-mono">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#22C55E', opacity: 0.6 }} /> Output tokens
          </div>
        </div>
      </div>

      {/* Average Stage Timing — stacked bar matching app's StageTimingBar */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#a3a3a3] font-mono mb-1">Average Stage Timing</div>
        <div className="text-[9px] text-[#404040] font-mono mb-3">Time distribution across pipeline stages</div>
        <div className="h-8 rounded overflow-hidden flex">
          <div
            className="flex items-center justify-center text-[10px] font-mono text-white"
            style={{ width: '66%', backgroundColor: '#3B82F6', opacity: 0.5 }}
          >
            Agents
          </div>
          <div
            className="flex items-center justify-center text-[10px] font-mono text-white"
            style={{ width: '34%', backgroundColor: '#F59E0B', opacity: 0.5 }}
          >
            Council
          </div>
        </div>
        <div className="flex justify-between mt-2 text-[9px] font-mono text-[#404040]">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#3B82F6', opacity: 0.5 }} />
            Stage 1 — Agents: 38.2s
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#F59E0B', opacity: 0.5 }} />
            Stage 2+3 — Council: 19.8s
          </div>
          <div>Total: 58.0s</div>
        </div>
      </div>
    </div>
  );
}

// ─── Tab: Models (mirrors app's ModelsTab) ────────────────────────────────────

function ModelsTab() {
  const maxTokens = Math.max(...MODELS.map((m) => m.inputTokens + m.outputTokens));
  const maxTime = Math.max(...MODELS.map((m) => m.avgTime));

  return (
    <div className="space-y-4">
      {/* Model Comparison Table — matches app's full table */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#1f1f1f]">
          <span className="text-[10px] text-[#a3a3a3] font-mono">Model Comparison</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="border-b border-[#1f1f1f] text-[9px] text-[#404040]">
                <th className="text-left px-4 py-2 font-medium">Model</th>
                <th className="text-right px-3 py-2 font-medium">Runs</th>
                <th className="text-right px-3 py-2 font-medium">Input Tokens</th>
                <th className="text-right px-3 py-2 font-medium">Output Tokens</th>
                <th className="text-right px-3 py-2 font-medium">Total Cost</th>
                <th className="text-right px-3 py-2 font-medium">Avg Time</th>
                <th className="text-right px-4 py-2 font-medium">Avg Rank</th>
              </tr>
            </thead>
            <tbody>
              {MODELS.map((m, i) => (
                <tr key={m.name} className={`border-b border-[#1f1f1f]/50 ${i % 2 === 0 ? '' : 'bg-[#050505]/30'}`}>
                  <td className="px-4 py-2 text-[#e5e5e5] truncate max-w-[180px]" title={m.name}>
                    <span className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
                      {m.name}
                    </span>
                  </td>
                  <td className="text-right px-3 py-2 text-[#a3a3a3]">{m.runs}</td>
                  <td className="text-right px-3 py-2 text-[#3B82F6]">{(m.inputTokens / 1000).toFixed(1)}k</td>
                  <td className="text-right px-3 py-2 text-[#22C55E]">{(m.outputTokens / 1000).toFixed(1)}k</td>
                  <td className="text-right px-3 py-2 text-[#F59E0B]">${m.cost.toFixed(2)}</td>
                  <td className="text-right px-3 py-2 text-[#a3a3a3]">{m.avgTime}s</td>
                  <td className="text-right px-4 py-2 text-[#a3a3a3]">{m.avgRank.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Total Tokens per Model */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#a3a3a3] font-mono mb-1">Total Tokens per Model</div>
        <div className="text-[9px] text-[#404040] font-mono mb-3">Combined input + output tokens</div>
        {MODELS.map((m) => (
          <HBar
            key={m.name}
            label={m.name.split(' · ')[0]}
            value={m.inputTokens + m.outputTokens}
            maxValue={maxTokens}
            color={m.color}
            displayValue={`${((m.inputTokens + m.outputTokens) / 1000).toFixed(1)}k`}
          />
        ))}
      </div>

      {/* Average Execution Time per Model */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#a3a3a3] font-mono mb-1">Average Execution Time</div>
        <div className="text-[9px] text-[#404040] font-mono mb-3">Stage 1 agent completion time</div>
        {[...MODELS].sort((a, b) => a.avgTime - b.avgTime).map((m) => (
          <HBar
            key={m.name}
            label={m.name.split(' · ')[0]}
            value={m.avgTime}
            maxValue={maxTime}
            color={m.color}
            displayValue={`${m.avgTime}s`}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Tab: Costs (mirrors app's CostsTab) ──────────────────────────────────────

function CostsTab() {
  const totalCost = MODELS.reduce((s, m) => s + m.cost, 0);
  const totalTokens = MODELS.reduce((s, m) => s + m.inputTokens + m.outputTokens, 0);
  const costPer1k = totalCost / (totalTokens / 1000);
  const mostExpensive = [...MODELS].sort((a, b) => b.cost - a.cost)[0];
  const maxModelCost = Math.max(...MODELS.map((m) => m.cost));
  const maxDateCost = Math.max(...COST_BY_DATE.map((d) => d.cost));

  // Cost efficiency: cost per 1k tokens per model (lower = better)
  const costEfficiency = MODELS
    .map((m) => ({
      name: m.name,
      color: m.color,
      costPer1k: m.cost / ((m.inputTokens + m.outputTokens) / 1000),
    }))
    .sort((a, b) => a.costPer1k - b.costPer1k);
  const maxCostPer1k = Math.max(...costEfficiency.map((c) => c.costPer1k));

  return (
    <div className="space-y-4">
      {/* Cost Summary Cards — matches app's 4-card grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Spend" color="text-[#F59E0B]">
          <AnimatedNumber value={totalCost} prefix="$" decimals={2} />
        </StatCard>
        <StatCard label="Avg Cost / Run">
          <AnimatedNumber value={totalCost / 20} prefix="$" decimals={3} />
        </StatCard>
        <StatCard label="Cost / 1k Tokens" sub="blended average">
          <AnimatedNumber value={costPer1k} prefix="$" decimals={4} />
        </StatCard>
        <StatCard label="Most Expensive" sub={`$${mostExpensive.cost.toFixed(2)}`}>
          <span className="text-base">{mostExpensive.name.split(' · ')[0]}</span>
        </StatCard>
      </div>

      {/* Cost per Model */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#a3a3a3] font-mono mb-1">Cost per Model</div>
        <div className="text-[9px] text-[#404040] font-mono mb-3">Total accumulated cost</div>
        {[...MODELS].sort((a, b) => b.cost - a.cost).map((m) => (
          <HBar
            key={m.name}
            label={m.name.split(' · ')[0]}
            value={m.cost}
            maxValue={maxModelCost}
            color={m.color}
            displayValue={`$${m.cost.toFixed(2)}`}
          />
        ))}
      </div>

      {/* Cost Efficiency */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#a3a3a3] font-mono mb-1">Cost Efficiency</div>
        <div className="text-[9px] text-[#404040] font-mono mb-3">Cost per 1,000 tokens — lower is better</div>
        {costEfficiency.map((c) => (
          <HBar
            key={c.name}
            label={c.name.split(' · ')[0]}
            value={c.costPer1k}
            maxValue={maxCostPer1k}
            color={c.color}
            displayValue={`$${c.costPer1k.toFixed(4)}`}
          />
        ))}
      </div>

      {/* Spend Over Time */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#a3a3a3] font-mono mb-1">Spend Over Time</div>
        <div className="text-[9px] text-[#404040] font-mono mb-3">Daily cost breakdown</div>
        {COST_BY_DATE.map((d) => (
          <HBar
            key={d.date}
            label={d.date}
            value={d.cost}
            maxValue={maxDateCost}
            color="#F59E0B"
            displayValue={`$${d.cost.toFixed(2)}`}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Tab: Performance (mirrors app's PerformanceTab) ──────────────────────────

function PerformanceTab() {
  const maxWinRate = Math.max(...MODELS.map((m) => (m.wins / m.runs) * 100));
  const maxWins = Math.max(...MODELS.map((m) => m.wins));

  // Quality/cost efficiency: 1 / (avgRank * costPerRun)
  const efficiencyScores = MODELS.map((m) => {
    const costPerRun = m.cost / m.runs;
    const score = 1 / (m.avgRank * costPerRun);
    return { name: m.name, color: m.color, score, avgRank: m.avgRank, costPerRun };
  }).sort((a, b) => b.score - a.score);
  const maxEff = Math.max(...efficiencyScores.map((e) => e.score));

  return (
    <div className="space-y-4">
      {/* Win Rate */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#a3a3a3] font-mono mb-1">Win Rate</div>
        <div className="text-[9px] text-[#404040] font-mono mb-3">Percentage of runs where model was ranked #1 by jurors</div>
        {[...MODELS].sort((a, b) => (b.wins / b.runs) - (a.wins / a.runs)).map((m) => (
          <HBar
            key={m.name}
            label={m.name.split(' · ')[0]}
            value={(m.wins / m.runs) * 100}
            maxValue={maxWinRate}
            color={m.color}
            displayValue={`${((m.wins / m.runs) * 100).toFixed(0)}% (${m.wins}/${m.runs})`}
          />
        ))}
      </div>

      {/* Total #1 Rankings */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#a3a3a3] font-mono mb-1">Total #1 Rankings</div>
        <div className="text-[9px] text-[#404040] font-mono mb-3">Number of times each model was ranked first</div>
        {[...MODELS].sort((a, b) => b.wins - a.wins).map((m) => (
          <HBar
            key={m.name}
            label={m.name.split(' · ')[0]}
            value={m.wins}
            maxValue={maxWins}
            color={m.color}
            displayValue={`${m.wins} wins`}
          />
        ))}
      </div>

      {/* Average Ranking Table */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#1f1f1f]">
          <div className="text-[10px] text-[#a3a3a3] font-mono">Average Ranking</div>
          <div className="text-[9px] text-[#404040] font-mono">Lower is better — averaged across all juror evaluations</div>
        </div>
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="border-b border-[#1f1f1f] text-[9px] text-[#404040]">
              <th className="text-left px-4 py-2 font-medium">Model</th>
              <th className="text-right px-3 py-2 font-medium">Avg Rank</th>
              <th className="text-right px-3 py-2 font-medium">Times Ranked</th>
              <th className="text-right px-3 py-2 font-medium">Wins</th>
              <th className="text-left px-4 py-2 font-medium">Distribution</th>
            </tr>
          </thead>
          <tbody>
            {[...MODELS].sort((a, b) => a.avgRank - b.avgRank).map((m, i) => {
              const maxR = Math.max(...MODELS.map((x) => x.avgRank));
              const barPct = maxR > 0 ? ((maxR - m.avgRank + 1) / (maxR + 1)) * 100 : 0;
              return (
                <tr key={m.name} className="border-b border-[#1f1f1f]/50">
                  <td className="px-4 py-2 text-[#e5e5e5] truncate max-w-[160px]">
                    <span className="flex items-center gap-2">
                      <span className={`text-[10px] ${i === 0 ? 'text-[#22C55E]' : 'text-[#404040]'}`}>#{i + 1}</span>
                      {m.name.split(' · ')[0]}
                    </span>
                  </td>
                  <td className="text-right px-3 py-2 text-[#a3a3a3]">{m.avgRank.toFixed(2)}</td>
                  <td className="text-right px-3 py-2 text-[#404040]">{m.totalRankings}</td>
                  <td className="text-right px-3 py-2 text-[#22C55E]">{m.wins}</td>
                  <td className="px-4 py-2">
                    <div className="h-2 bg-[#1a1a1a] rounded-full overflow-hidden w-24">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${barPct}%`, backgroundColor: i === 0 ? '#22C55E' : '#3B82F6', opacity: i === 0 ? 0.6 : 0.4 }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Quality/Cost Efficiency */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#a3a3a3] font-mono mb-1">Quality/Cost Efficiency</div>
        <div className="text-[9px] text-[#404040] font-mono mb-3">Higher is better — models that rank well while costing less score higher</div>
        {efficiencyScores.map((e) => (
          <HBar
            key={e.name}
            label={e.name.split(' · ')[0]}
            value={e.score}
            maxValue={maxEff}
            color={e.color}
            displayValue={`rank ${e.avgRank.toFixed(1)} · $${e.costPerRun.toFixed(3)}/run`}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Tab: Run History (mirrors app's HistoryTab) ──────────────────────────────

function RunHistoryTab() {
  return (
    <div>
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#1f1f1f] flex items-center justify-between">
          <span className="text-[10px] text-[#a3a3a3] font-mono">Run History</span>
          <span className="text-[9px] text-[#404040] font-mono">{RUN_HISTORY.length} runs</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="border-b border-[#1f1f1f] text-[9px] text-[#404040]">
                <th className="text-left px-4 py-2 font-medium w-10">Status</th>
                <th className="text-right px-3 py-2 font-medium">Date</th>
                <th className="text-left px-3 py-2 font-medium">Prompt</th>
                <th className="text-center px-3 py-2 font-medium">Models</th>
                <th className="text-right px-3 py-2 font-medium">Tokens</th>
                <th className="text-right px-3 py-2 font-medium">Cost</th>
                <th className="text-right px-4 py-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {RUN_HISTORY.map((run, i) => (
                <tr key={i} className={`border-b border-[#1f1f1f]/50 ${i % 2 !== 0 ? 'bg-[#050505]/30' : ''}`}>
                  <td className="px-4 py-2">
                    <span
                      className="w-2 h-2 rounded-full inline-block"
                      style={{ backgroundColor: run.status ? '#22C55E' : '#EF4444' }}
                    />
                  </td>
                  <td className="text-right px-3 py-2 text-[#404040] whitespace-nowrap">{run.date}</td>
                  <td className="text-left px-3 py-2 text-[#a3a3a3] truncate max-w-[220px]" title={run.prompt}>{run.prompt}</td>
                  <td className="text-center px-3 py-2 text-[#404040]">{run.agents}</td>
                  <td className="text-right px-3 py-2 text-[#3B82F6]">{(run.tokens / 1000).toFixed(1)}k</td>
                  <td className="text-right px-3 py-2 text-[#F59E0B]">${run.cost.toFixed(2)}</td>
                  <td className="text-right px-4 py-2 text-[#a3a3a3]">{run.duration}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AnalyticsShowcase() {
  const [activeTab, setActiveTab] = useState<Tab>('Overview');

  return (
    <div className="bg-[#0c0c0c] border border-[#262626] rounded-xl overflow-hidden font-mono">
      {/* Title bar */}
      <div className="flex items-center justify-between px-4 h-10 bg-[#121212] border-b border-[#1f1f1f]">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#22C55E] animate-pulse shadow-[0_0_6px_rgba(34,197,94,0.4)]" />
          <span className="text-[10px] text-[#a3a3a3] font-mono uppercase tracking-wider font-medium">Analytics Dashboard</span>
        </div>
        <span className="text-[9px] text-[#404040] font-mono">20 runs · 6 days</span>
      </div>

      {/* Tabs — matches app's 5 tabs exactly */}
      <div className="flex border-b border-[#1f1f1f] bg-[#121212]/50 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-[10px] font-mono uppercase tracking-wider transition-all relative whitespace-nowrap
              ${activeTab === tab
                ? 'text-[#22C55E] font-bold'
                : 'text-[#525252] hover:text-[#a3a3a3]'
              }`}
          >
            {tab}
            {activeTab === tab && (
              <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#22C55E]" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-4 md:p-6 min-h-[360px]">
        {activeTab === 'Overview' && <OverviewTab />}
        {activeTab === 'Models' && <ModelsTab />}
        {activeTab === 'Costs' && <CostsTab />}
        {activeTab === 'Performance' && <PerformanceTab />}
        {activeTab === 'Run History' && <RunHistoryTab />}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-[#1f1f1f] bg-[#121212]/50 flex items-center justify-between">
        <span className="text-[9px] text-[#404040] font-mono">sample data for demonstration</span>
        <span className="text-[9px] text-[#22C55E]/60 font-mono">all data stays local</span>
      </div>
    </div>
  );
}
