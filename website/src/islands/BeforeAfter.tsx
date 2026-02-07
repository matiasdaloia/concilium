import { useState } from 'react';

const chaosItems = [
  { icon: '>', label: 'Terminal 1', tool: 'claude', color: '#A855F7', lines: ['$ claude "implement auth..."', 'Thinking...', '## JWT approach with refresh tokens...'] },
  { icon: '>', label: 'Terminal 2', tool: 'codex', color: '#3B82F6', lines: ['$ codex "implement auth..."', 'Running...', '## Session-based with Redis store...'] },
  { icon: '>', label: 'Terminal 3', tool: 'opencode', color: '#22C55E', lines: ['$ opencode "implement auth..."', 'Processing...', '## OAuth2 with PKCE flow...'] },
];

export default function BeforeAfter() {
  const [active, setActive] = useState<'before' | 'after'>('before');

  return (
    <div className="max-w-7xl mx-auto px-6">
      {/* Toggle */}
      <div className="flex justify-center mb-10">
        <div className="inline-flex bg-bg-surface border border-border-primary rounded-lg p-1">
          <button
            onClick={() => setActive('before')}
            className={`px-6 py-2.5 rounded-md text-xs font-mono font-medium transition-all duration-300 ${
              active === 'before'
                ? 'bg-red-error/10 text-red-error border border-red-error/20'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            Without Concilium
          </button>
          <button
            onClick={() => setActive('after')}
            className={`px-6 py-2.5 rounded-md text-xs font-mono font-medium transition-all duration-300 ${
              active === 'after'
                ? 'bg-green-primary/10 text-green-primary border border-green-primary/20'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            With Concilium
          </button>
        </div>
      </div>

      {/* Before: The Chaos */}
      {active === 'before' && (
        <div className="space-y-6 animate-in fade-in duration-300">
          {/* Messy multi-window view */}
          <div className="grid md:grid-cols-3 gap-4">
            {chaosItems.map((item, i) => (
              <div key={i} className="bg-bg-page border border-border-primary rounded-lg overflow-hidden opacity-90">
                {/* Window chrome */}
                <div className="flex items-center gap-2 px-3 py-2 bg-bg-surface border-b border-border-primary">
                  <div className="flex gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-red-error/60"></div>
                    <div className="w-2 h-2 rounded-full bg-amber-warning/60"></div>
                    <div className="w-2 h-2 rounded-full bg-green-primary/60"></div>
                  </div>
                  <span className="text-[10px] text-text-muted font-mono ml-2">{item.label} &mdash; {item.tool}</span>
                </div>
                <div className="p-3 space-y-1.5 min-h-[100px]">
                  {item.lines.map((line, j) => (
                    <div key={j} className="text-[11px] font-mono" style={{ color: j === 0 ? item.color : '#737373' }}>
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* The manual comparison nightmare */}
          <div className="bg-bg-surface border border-red-error/10 rounded-lg p-6 space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-red-error/60"></div>
              <span className="text-xs text-red-error/80 font-mono font-medium">Then you have to...</span>
            </div>
            <div className="grid md:grid-cols-4 gap-4 text-center">
              {[
                { step: '1', text: 'Read all 3 outputs', sub: 'Context-switch between terminals' },
                { step: '2', text: 'Compare manually', sub: 'Spot differences in approach' },
                { step: '3', text: 'Decide which is best', sub: 'Hope you picked right' },
                { step: '4', text: 'Miss the edge cases', sub: 'No peer review, no validation' },
              ].map((s) => (
                <div key={s.step} className="flex flex-col items-center gap-2 py-3">
                  <div className="w-7 h-7 rounded-full border border-red-error/20 flex items-center justify-center text-[10px] text-red-error/60 font-bold font-mono">
                    {s.step}
                  </div>
                  <span className="text-xs text-text-primary font-medium">{s.text}</span>
                  <span className="text-[10px] text-text-muted leading-tight">{s.sub}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* After: Concilium */}
      {active === 'after' && (
        <div className="space-y-6 animate-in fade-in duration-300">
          {/* Single unified window */}
          <div className="bg-bg-page border border-green-primary/20 rounded-lg overflow-hidden shadow-[0_0_40px_rgba(34,197,94,0.05)]">
            {/* App chrome */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-bg-surface border-b border-border-primary">
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-red-error/60"></div>
                  <div className="w-2 h-2 rounded-full bg-amber-warning/60"></div>
                  <div className="w-2 h-2 rounded-full bg-green-primary/60"></div>
                </div>
                <span className="text-[11px] text-text-primary font-mono font-medium">Concilium</span>
              </div>
              <div className="flex items-center gap-4 text-[10px] font-mono text-text-muted">
                <span className="text-green-primary">Stage 3 of 3</span>
                <span>Synthesis complete</span>
              </div>
            </div>

            {/* Agent panes side by side */}
            <div className="flex divide-x divide-border-primary">
              {chaosItems.map((item, i) => (
                <div key={i} className="flex-1 p-3 min-h-[80px]">
                  <div className="flex items-center gap-1.5 mb-2">
                    <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: item.color, boxShadow: `0 0 6px ${item.color}40` }}></div>
                    <span className="text-[9px] text-text-muted font-mono uppercase">{item.tool}</span>
                    <span className="text-[9px] text-green-primary ml-auto font-mono">done</span>
                  </div>
                  <div className="space-y-1 opacity-50">
                    <div className="h-1 bg-white/15 rounded w-full"></div>
                    <div className="h-1 bg-white/15 rounded w-3/4"></div>
                    <div className="h-1 bg-white/15 rounded w-5/6"></div>
                  </div>
                </div>
              ))}
            </div>

            {/* Synthesis result */}
            <div className="border-t border-border-primary p-4 bg-green-primary/[0.02]">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-green-primary shadow-[0_0_8px_#22c55e]"></div>
                <span className="text-[10px] text-green-primary font-mono font-bold uppercase tracking-wider">Synthesized Answer</span>
              </div>
              <div className="text-xs text-text-secondary font-mono leading-relaxed space-y-1.5">
                <p className="text-text-primary font-medium">Hybrid approach combining the best of all three:</p>
                <p>1. JWT for stateless API auth (from Claude)</p>
                <p>2. Redis session store for revocation (from Codex)</p>
                <p>3. PKCE flow for OAuth security (from OpenCode)</p>
              </div>
            </div>
          </div>

          {/* Benefits strip */}
          <div className="bg-bg-surface border border-green-primary/10 rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full bg-green-primary"></div>
              <span className="text-xs text-green-primary font-mono font-medium">What Concilium handles for you</span>
            </div>
            <div className="grid md:grid-cols-4 gap-4 text-center">
              {[
                { step: '1', text: 'Runs all agents', sub: 'Parallel execution, one click' },
                { step: '2', text: 'Blind peer review', sub: 'Models critique each other' },
                { step: '3', text: 'Ranks by quality', sub: 'Objective, bias-free scoring' },
                { step: '4', text: 'Synthesizes the best', sub: 'One answer, fully validated' },
              ].map((s) => (
                <div key={s.step} className="flex flex-col items-center gap-2 py-3">
                  <div className="w-7 h-7 rounded-full bg-green-primary/10 border border-green-primary/20 flex items-center justify-center text-[10px] text-green-primary font-bold font-mono">
                    {s.step}
                  </div>
                  <span className="text-xs text-text-primary font-medium">{s.text}</span>
                  <span className="text-[10px] text-text-muted leading-tight">{s.sub}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
