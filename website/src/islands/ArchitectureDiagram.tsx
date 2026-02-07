import { useState } from 'react';
import { colors } from '../styles/tokens';

interface BoxProps {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  fill?: string;
  stroke?: string;
  textColor?: string;
  fontSize?: number;
  rx?: number;
  highlighted?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

function Box({ x, y, width, height, label, fill = colors.bgPage, stroke = colors.borderSecondary, textColor = colors.textPrimary, fontSize = 11, rx = 6, highlighted, onMouseEnter, onMouseLeave }: BoxProps) {
  return (
    <g onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ cursor: 'pointer' }}>
      <rect
        x={x} y={y} width={width} height={height} rx={rx}
        fill={fill}
        stroke={highlighted ? colors.greenPrimary : stroke}
        strokeWidth={highlighted ? 2 : 1}
        style={{ transition: 'stroke 0.2s, stroke-width 0.2s' }}
      />
      <text
        x={x + width / 2} y={y + height / 2 + 4}
        textAnchor="middle" fill={textColor}
        fontFamily="'JetBrains Mono', monospace" fontSize={fontSize}
      >
        {label}
      </text>
    </g>
  );
}

function AnimatedLine({ x1, y1, x2, y2, highlighted }: { x1: number; y1: number; x2: number; y2: number; highlighted?: boolean }) {
  return (
    <line
      x1={x1} y1={y1} x2={x2} y2={y2}
      stroke={highlighted ? colors.greenPrimary : colors.borderSecondary}
      strokeWidth={highlighted ? 2 : 1.5}
      strokeDasharray="6 4"
      style={{
        transition: 'stroke 0.2s',
        animation: highlighted ? 'dash-flow 0.8s linear infinite' : undefined,
      }}
    />
  );
}

export default function ArchitectureDiagram() {
  const [hovered, setHovered] = useState<string | null>(null);

  const isHighlighted = (group: string) => hovered === group;

  return (
    <div className="max-w-6xl mx-auto px-6 -mt-8">
      <div className="bg-bg-surface border border-border-primary rounded-lg p-4 md:p-8 overflow-x-auto">
        <svg viewBox="0 0 900 420" className="w-full min-w-[600px] h-auto" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* Main Process container */}
          <rect x="20" y="20" width="340" height="380" rx="8" stroke={colors.borderPrimary} strokeWidth="2" fill={colors.bgSurface} />
          <text x="40" y="48" fill={colors.textSecondary} fontFamily="'JetBrains Mono', monospace" fontSize="12" fontWeight="500">Main Process</text>

          {/* Main process modules */}
          <Box x={40} y={65} width={140} height={45} label="runner.ts"
            highlighted={isHighlighted('runner')} onMouseEnter={() => setHovered('runner')} onMouseLeave={() => setHovered(null)} />
          <Box x={200} y={65} width={140} height={45} label="pipeline.ts"
            highlighted={isHighlighted('pipeline')} onMouseEnter={() => setHovered('pipeline')} onMouseLeave={() => setHovered(null)} />
          <Box x={40} y={125} width={140} height={45} label="openrouter.ts"
            highlighted={isHighlighted('pipeline')} onMouseEnter={() => setHovered('pipeline')} onMouseLeave={() => setHovered(null)} />
          <Box x={200} y={125} width={140} height={45} label="storage.ts"
            highlighted={isHighlighted('storage')} onMouseEnter={() => setHovered('storage')} onMouseLeave={() => setHovered(null)} />

          {/* CLI Subprocesses label */}
          <text x="40" y="205" fill={colors.textTertiary} fontFamily="'JetBrains Mono', monospace" fontSize="10">CLI Subprocesses</text>

          {/* CLI boxes */}
          <Box x={40} y={215} width={90} height={35} label="opencode" rx={4}
            fill={`${colors.providerOpencode}10`} stroke={`${colors.providerOpencode}40`} textColor={colors.providerOpencode} fontSize={10}
            highlighted={isHighlighted('runner')} onMouseEnter={() => setHovered('runner')} onMouseLeave={() => setHovered(null)} />
          <Box x={145} y={215} width={90} height={35} label="codex" rx={4}
            fill={`${colors.providerCodex}10`} stroke={`${colors.providerCodex}40`} textColor={colors.providerCodex} fontSize={10}
            highlighted={isHighlighted('runner')} onMouseEnter={() => setHovered('runner')} onMouseLeave={() => setHovered(null)} />
          <Box x={250} y={215} width={90} height={35} label="claude" rx={4}
            fill={`${colors.providerClaude}10`} stroke={`${colors.providerClaude}40`} textColor={colors.providerClaude} fontSize={10}
            highlighted={isHighlighted('runner')} onMouseEnter={() => setHovered('runner')} onMouseLeave={() => setHovered(null)} />

          {/* OpenRouter API */}
          <Box x={40} y={275} width={300} height={40} label="OpenRouter API"
            fill={`${colors.amberWarning}08`} stroke={`${colors.amberWarning}40`} textColor={colors.amberWarning}
            highlighted={isHighlighted('pipeline')} onMouseEnter={() => setHovered('pipeline')} onMouseLeave={() => setHovered(null)} />

          {/* IPC labels */}
          <text x="40" y="345" fill={colors.textTertiary} fontFamily="'JetBrains Mono', monospace" fontSize="9">
            {hovered === 'runner' ? 'agent:status, agent:event' : hovered === 'pipeline' ? 'stage:change, juror:chunk' : hovered === 'storage' ? 'run:complete' : ''}
          </text>

          {/* IPC Bridge */}
          <rect x="400" y="130" width="100" height="140" rx="8" fill={`${colors.greenPrimary}10`} stroke={`${colors.greenPrimary}30`} strokeWidth="1.5" />
          <text x="427" y="198" fill={colors.greenPrimary} fontFamily="'JetBrains Mono', monospace" fontSize="13" fontWeight="bold">IPC</text>
          <text x="410" y="218" fill={colors.textTertiary} fontFamily="'JetBrains Mono', monospace" fontSize="8">contextBridge</text>
          <text x="416" y="232" fill={colors.textTertiary} fontFamily="'JetBrains Mono', monospace" fontSize="8">preload.ts</text>

          {/* Connecting lines */}
          <AnimatedLine x1={360} y1={200} x2={400} y2={200} highlighted={hovered !== null} />
          <AnimatedLine x1={500} y1={200} x2={540} y2={200} highlighted={hovered !== null} />

          {/* Renderer container */}
          <rect x="540" y="20" width="340" height="380" rx="8" stroke={colors.borderPrimary} strokeWidth="2" fill={colors.bgSurface} />
          <text x="560" y="48" fill={colors.textSecondary} fontFamily="'JetBrains Mono', monospace" fontSize="12" fontWeight="500">Renderer (React)</text>

          {/* Hook */}
          <Box x={560} y={65} width={300} height={45} label="useCouncilRun" highlighted={isHighlighted('runner') || isHighlighted('pipeline')} />

          {/* Components */}
          <Box x={560} y={125} width={140} height={40} label="AgentPane"
            highlighted={isHighlighted('runner')} onMouseEnter={() => setHovered('runner')} onMouseLeave={() => setHovered(null)} />
          <Box x={720} y={125} width={140} height={40} label="StageProgress"
            highlighted={isHighlighted('pipeline')} onMouseEnter={() => setHovered('pipeline')} onMouseLeave={() => setHovered(null)} />
          <Box x={560} y={180} width={140} height={40} label="Leaderboard"
            highlighted={isHighlighted('pipeline')} onMouseEnter={() => setHovered('pipeline')} onMouseLeave={() => setHovered(null)} />
          <Box x={720} y={180} width={140} height={40} label="MarkdownRenderer" fontSize={10} />

          {/* Screens */}
          <text x="560" y="255" fill={colors.textTertiary} fontFamily="'JetBrains Mono', monospace" fontSize="10">Screens</text>
          <Box x={560} y={265} width={95} height={35} label="Home" rx={4} fontSize={10} textColor={colors.textSecondary} />
          <Box x={665} y={265} width={95} height={35} label="Running" rx={4} fontSize={10} textColor={colors.textSecondary}
            highlighted={isHighlighted('runner') || isHighlighted('pipeline')} />
          <Box x={770} y={265} width={95} height={35} label="Results" rx={4} fontSize={10} textColor={colors.textSecondary}
            highlighted={isHighlighted('storage')} />

          {/* Data flow labels */}
          <text x="560" y="335" fill={colors.textTertiary} fontFamily="'JetBrains Mono', monospace" fontSize="9">
            Stage 1: CLI subprocess → runner → IPC → AgentPane
          </text>
          <text x="560" y="350" fill={colors.textTertiary} fontFamily="'JetBrains Mono', monospace" fontSize="9">
            Stage 2-3: OpenRouter → pipeline → IPC → Leaderboard
          </text>
        </svg>

        {/* Legend */}
        <div className="flex flex-wrap gap-4 mt-4 text-[10px] text-text-muted font-mono">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-provider-opencode" /> OpenCode
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-provider-codex" /> Codex
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-provider-claude" /> Claude
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-warning" /> OpenRouter
          </span>
          <span className="ml-auto text-text-muted">hover to highlight data flow</span>
        </div>
      </div>
    </div>
  );
}
