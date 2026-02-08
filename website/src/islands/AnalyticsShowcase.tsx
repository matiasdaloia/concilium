import { useState, useEffect, useRef } from 'react';

// ─── Sample data ──────────────────────────────────────────────────────────────

const MODELS = [
  { name: 'Claude Code', color: '#A855F7', tokens: 48200, cost: 1.24, wins: 14, runs: 20, avgTime: 42 },
  { name: 'OpenCode', color: '#22C55E', tokens: 35800, cost: 0.87, wins: 11, runs: 20, avgTime: 38 },
  { name: 'Codex CLI', color: '#3B82F6', tokens: 41500, cost: 1.05, wins: 8, runs: 20, avgTime: 55 },
];

const STAGE_TIMING = [
  { name: 'Execution', time: 38, color: '#22C55E' },
  { name: 'Review', time: 12, color: '#F59E0B' },
  { name: 'Synthesis', time: 8, color: '#A855F7' },
];

const COST_HISTORY = [
  { day: 'Mon', cost: 2.40 },
  { day: 'Tue', cost: 3.10 },
  { day: 'Wed', cost: 1.80 },
  { day: 'Thu', cost: 4.20 },
  { day: 'Fri', cost: 3.50 },
  { day: 'Sat', cost: 1.20 },
  { day: 'Sun', cost: 2.80 },
];

const TABS = ['Overview', 'Models', 'Costs', 'Timing'] as const;
type Tab = (typeof TABS)[number];

// ─── Animated number ──────────────────────────────────────────────────────────

function AnimatedNumber({ value, prefix = '', suffix = '', decimals = 0 }: {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
}) {
  const [displayed, setDisplayed] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
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

  return (
    <span ref={ref}>
      {prefix}{displayed.toFixed(decimals)}{suffix}
    </span>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ label, children, color = 'text-text-primary' }: {
  label: string;
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
      <div className="text-[10px] text-[#404040] uppercase tracking-wider font-mono mb-2">{label}</div>
      <div className={`text-xl font-bold font-mono ${color}`}>{children}</div>
    </div>
  );
}

// ─── Bar chart component ──────────────────────────────────────────────────────

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
      <span className="text-[11px] text-[#a3a3a3] font-mono w-28 shrink-0 truncate">{label}</span>
      <div className="flex-1 h-5 bg-[#1a1a1a] rounded overflow-hidden relative">
        <div
          className="h-full rounded transition-all duration-700 ease-out"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-[11px] text-[#a3a3a3] font-mono w-16 text-right shrink-0">{displayValue}</span>
    </div>
  );
}

// ─── Mini bar chart (vertical) ────────────────────────────────────────────────

function CostChart({ data }: { data: typeof COST_HISTORY }) {
  const max = Math.max(...data.map((d) => d.cost));
  return (
    <div className="flex items-end gap-2 h-32 pt-4">
      {data.map((d) => {
        const h = max > 0 ? (d.cost / max) * 100 : 0;
        return (
          <div key={d.day} className="flex-1 flex flex-col items-center gap-2">
            <span className="text-[9px] text-[#525252] font-mono">${d.cost.toFixed(2)}</span>
            <div className="w-full bg-[#1a1a1a] rounded-t relative" style={{ height: '80px' }}>
              <div
                className="absolute bottom-0 w-full rounded-t transition-all duration-700 ease-out bg-gradient-to-t from-[#22C55E] to-[#22C55E]/60"
                style={{ height: `${h}%` }}
              />
            </div>
            <span className="text-[9px] text-[#404040] font-mono">{d.day}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Tab contents ─────────────────────────────────────────────────────────────

function OverviewTab() {
  const totalTokens = MODELS.reduce((s, m) => s + m.tokens, 0);
  const totalCost = MODELS.reduce((s, m) => s + m.cost, 0);
  const totalTime = STAGE_TIMING.reduce((s, st) => s + st.time, 0);
  const topModel = [...MODELS].sort((a, b) => b.wins - a.wins)[0];

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total Tokens" color="text-[#22C55E]">
          <AnimatedNumber value={totalTokens} suffix="" decimals={0} />
        </StatCard>
        <StatCard label="Total Cost" color="text-[#F59E0B]">
          <AnimatedNumber value={totalCost} prefix="$" decimals={2} />
        </StatCard>
        <StatCard label="Avg Run Time" color="text-[#3B82F6]">
          <AnimatedNumber value={totalTime} suffix="s" decimals={0} />
        </StatCard>
        <StatCard label="Top Model" color="text-[#A855F7]">
          {topModel.name}
        </StatCard>
      </div>

      {/* Win rate bars */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#404040] uppercase tracking-wider font-mono mb-3">Win Rate by Model</div>
        {MODELS.map((m) => (
          <HBar
            key={m.name}
            label={m.name}
            value={m.wins}
            maxValue={m.runs}
            color={m.color}
            displayValue={`${((m.wins / m.runs) * 100).toFixed(0)}%`}
          />
        ))}
      </div>
    </div>
  );
}

function ModelsTab() {
  return (
    <div>
      {/* Leaderboard table */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg overflow-hidden mb-4">
        <div className="grid grid-cols-5 gap-2 px-4 py-2.5 border-b border-[#1f1f1f] text-[9px] text-[#404040] font-mono uppercase tracking-wider">
          <span>Model</span>
          <span className="text-right">Wins</span>
          <span className="text-right">Win Rate</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">Avg Time</span>
        </div>
        {[...MODELS].sort((a, b) => b.wins - a.wins).map((m, i) => (
          <div key={m.name} className={`grid grid-cols-5 gap-2 px-4 py-3 ${i < MODELS.length - 1 ? 'border-b border-[#1f1f1f]' : ''} hover:bg-white/[0.02] transition-colors`}>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
              <span className="text-[11px] text-[#e5e5e5] font-mono truncate">{m.name}</span>
            </div>
            <span className="text-[11px] text-[#e5e5e5] font-mono text-right font-bold">{m.wins}</span>
            <span className="text-[11px] text-[#a3a3a3] font-mono text-right">{((m.wins / m.runs) * 100).toFixed(0)}%</span>
            <span className="text-[11px] text-[#a3a3a3] font-mono text-right">{(m.tokens / 1000).toFixed(1)}k</span>
            <span className="text-[11px] text-[#a3a3a3] font-mono text-right">{m.avgTime}s</span>
          </div>
        ))}
      </div>

      {/* Token usage by model */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#404040] uppercase tracking-wider font-mono mb-3">Token Usage by Model</div>
        {MODELS.map((m) => (
          <HBar
            key={m.name}
            label={m.name}
            value={m.tokens}
            maxValue={Math.max(...MODELS.map((x) => x.tokens))}
            color={m.color}
            displayValue={`${(m.tokens / 1000).toFixed(1)}k`}
          />
        ))}
      </div>
    </div>
  );
}

function CostsTab() {
  const totalCost = MODELS.reduce((s, m) => s + m.cost, 0);
  const avgCostPerRun = totalCost / 20;

  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard label="Total Spend" color="text-[#F59E0B]">
          <AnimatedNumber value={totalCost} prefix="$" decimals={2} />
        </StatCard>
        <StatCard label="Avg / Run" color="text-[#a3a3a3]">
          <AnimatedNumber value={avgCostPerRun} prefix="$" decimals={3} />
        </StatCard>
        <StatCard label="This Week" color="text-[#22C55E]">
          <AnimatedNumber value={COST_HISTORY.reduce((s, d) => s + d.cost, 0)} prefix="$" decimals={2} />
        </StatCard>
      </div>

      {/* Cost by day chart */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#404040] uppercase tracking-wider font-mono mb-2">Daily Cost</div>
        <CostChart data={COST_HISTORY} />
      </div>

      {/* Cost by model */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4 mt-4">
        <div className="text-[10px] text-[#404040] uppercase tracking-wider font-mono mb-3">Cost by Model</div>
        {MODELS.map((m) => (
          <HBar
            key={m.name}
            label={m.name}
            value={m.cost}
            maxValue={Math.max(...MODELS.map((x) => x.cost))}
            color={m.color}
            displayValue={`$${m.cost.toFixed(2)}`}
          />
        ))}
      </div>
    </div>
  );
}

function TimingTab() {
  const totalTime = STAGE_TIMING.reduce((s, st) => s + st.time, 0);

  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        {STAGE_TIMING.map((st) => (
          <StatCard key={st.name} label={st.name} color={`text-[${st.color}]`}>
            <span style={{ color: st.color }}><AnimatedNumber value={st.time} suffix="s" decimals={0} /></span>
          </StatCard>
        ))}
      </div>

      {/* Stage timeline */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4 mb-4">
        <div className="text-[10px] text-[#404040] uppercase tracking-wider font-mono mb-3">Pipeline Timeline</div>
        <div className="flex rounded-lg overflow-hidden h-8">
          {STAGE_TIMING.map((st) => {
            const pct = (st.time / totalTime) * 100;
            return (
              <div
                key={st.name}
                className="flex items-center justify-center transition-all duration-700"
                style={{ width: `${pct}%`, backgroundColor: st.color }}
              >
                <span className="text-[9px] text-black font-bold font-mono">{st.name} ({st.time}s)</span>
              </div>
            );
          })}
        </div>
        <div className="flex justify-between mt-2">
          <span className="text-[9px] text-[#404040] font-mono">0s</span>
          <span className="text-[9px] text-[#404040] font-mono">{totalTime}s total</span>
        </div>
      </div>

      {/* Agent response time */}
      <div className="bg-[#0a0a0a] border border-[#262626] rounded-lg p-4">
        <div className="text-[10px] text-[#404040] uppercase tracking-wider font-mono mb-3">Avg Agent Response Time</div>
        {MODELS.map((m) => (
          <HBar
            key={m.name}
            label={m.name}
            value={m.avgTime}
            maxValue={Math.max(...MODELS.map((x) => x.avgTime))}
            color={m.color}
            displayValue={`${m.avgTime}s`}
          />
        ))}
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
        <span className="text-[9px] text-[#404040] font-mono">20 runs · 7 days</span>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#1f1f1f] bg-[#121212]/50">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-[10px] font-mono uppercase tracking-wider transition-all relative
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
        {activeTab === 'Timing' && <TimingTab />}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-[#1f1f1f] bg-[#121212]/50 flex items-center justify-between">
        <span className="text-[9px] text-[#404040] font-mono">sample data for demonstration</span>
        <span className="text-[9px] text-[#22C55E]/60 font-mono">all data stays local</span>
      </div>
    </div>
  );
}
