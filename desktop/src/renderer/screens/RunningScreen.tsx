import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import TitleBar from '../components/TitleBar';
import StageProgress from '../components/StageProgress';
import AgentPane from '../components/AgentPane';
import Badge from '../components/Badge';
import MarkdownRenderer from '../components/MarkdownRenderer';
import Leaderboard from '../components/Leaderboard';
import Button from '../components/Button';
import { useCouncilRun, type JurorState } from '../hooks/useCouncilRun';
import { api } from '../api';
import type { RunRecord } from '../types';

interface RunningScreenProps {
  runId: string;
  initialAgents?: Array<{ key: string; name: string }>;
  onComplete: (record: RunRecord) => void;
  onCancel: () => void;
}

interface JurorCardProps {
  model: string;
  juror: JurorState;
  jurorLabel: string;
  expanded: boolean;
  onToggleExpanded: () => void;
}

function JurorCard({ model, juror, jurorLabel, expanded, onToggleExpanded }: JurorCardProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const hasContent = juror.textContent.trim().length > 0;
  const status = juror.status;

  useEffect(() => {
    if (status !== 'evaluating') return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [status, juror.textContent, expanded]);

  const borderClass =
    status === 'evaluating'
      ? 'border-amber-warning/30'
      : status === 'complete'
        ? 'border-green-primary/30'
        : 'border-red-error/30';

  // Badge label: "complete" -> "complete" with checkmark style
  const badgeLabel = status === 'complete' ? '\u2713 complete' : status === 'evaluating' ? 'reviewing...' : status;

  return (
    <div className={`bg-bg-surface border rounded-lg transition-colors flex flex-col ${borderClass} ${expanded ? 'col-span-2' : ''}`}>
      <div className="flex items-center justify-between px-4 h-10 border-b border-border-primary/60 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${status === 'evaluating' ? 'bg-amber-warning animate-pulse' : status === 'complete' ? 'bg-green-primary' : 'bg-red-error'}`} />
          <span className="text-xs font-medium text-text-primary font-mono">{jurorLabel}</span>
          <span className="text-[10px] text-text-muted font-mono truncate">{model.split('/').slice(1).join('/') || model}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={status === 'complete' ? 'green' : status === 'failed' ? 'red' : 'amber'}>
            {badgeLabel}
          </Badge>
          <button
            type="button"
            onClick={onToggleExpanded}
            className="text-[10px] font-mono text-text-muted hover:text-text-primary transition-colors px-1.5 py-0.5 border border-border-secondary rounded"
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        </div>
      </div>

      <div
        ref={bodyRef}
        className={`p-4 overflow-y-auto flex-1 ${expanded ? 'max-h-[400px]' : 'min-h-48 max-h-56'}`}
      >
        {hasContent ? (
          <div>
            <MarkdownRenderer content={juror.textContent} className="text-xs" />
            {status === 'evaluating' && (
              <span className="inline-block w-1.5 h-3.5 bg-amber-warning animate-pulse rounded-sm align-middle ml-0.5" />
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <span className="text-[11px] text-text-muted font-mono">
              {status === 'evaluating' && 'scoring agent responses...'}
              {status === 'complete' && 'evaluation complete'}
              {status === 'failed' && 'evaluation failed'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function RunningScreen({ runId, initialAgents, onComplete, onCancel }: RunningScreenProps) {
  // Stage navigation state (1-3 for running stages, 4 for results)
  // Initialize to 1 but will update once run data is available
  const [viewStage, setViewStage] = useState<number>(1);
  const [isComplete, setIsComplete] = useState(false);
  const [finalRecord, setFinalRecord] = useState<RunRecord | null>(null);
  const hasInitialized = useRef(false);
  const lastAutoAdvancedStage = useRef(1);
  
  // Handle completion - store the record and enable stage 4
  const handleComplete = useCallback((record: RunRecord) => {
    setFinalRecord(record);
    setIsComplete(true);
    setViewStage(4);
    onComplete(record);
  }, [onComplete]);

  const run = useCouncilRun(runId, handleComplete, initialAgents);
  const [focusedAgent, setFocusedAgent] = useState<string | null>(null);
  const [expandedJuror, setExpandedJuror] = useState<string | null>(null);
  const [showRawDetails, setShowRawDetails] = useState(false);
  const startTime = useRef(Date.now());
  const [elapsed, setElapsed] = useState('0s');

  // Per-agent elapsed timers
  const [agentTimers, setAgentTimers] = useState<Record<string, string>>({});

  // Initialize viewStage once when run data is first available
  useEffect(() => {
    if (!hasInitialized.current && run.stage > 0) {
      setViewStage(run.stage);
      lastAutoAdvancedStage.current = run.stage;
      hasInitialized.current = true;
    }
  }, [run.stage]);

  // Calculate max viewable stage based on run progress
  const maxViewableStage = useMemo(() => {
    if (isComplete) return 4;
    if (run.stage === 3) return 3;
    if (run.stage === 2) {
      // Check if all jurors are complete
      const jurorEntries = Object.entries(run.jurors);
      const allComplete = jurorEntries.length > 0 && jurorEntries.every(([, j]) => j.status === 'complete' || j.status === 'failed');
      return allComplete ? 3 : 2;
    }
    // Stage 1: check if all agents are done
    const agentEntries = Object.entries(run.agents);
    const allComplete = agentEntries.length > 0 && agentEntries.every(([, a]) => a.status === 'success' || a.status === 'error');
    return allComplete ? 2 : 1;
  }, [run.stage, run.agents, run.jurors, isComplete]);

  // Keep view stage in sync with current stage when run progresses
  // Only auto-advance when run.stage increases, not when user manually navigates
  useEffect(() => {
    if (run.stage > lastAutoAdvancedStage.current && !isComplete) {
      setViewStage(run.stage);
      lastAutoAdvancedStage.current = run.stage;
    }
  }, [run.stage, isComplete]);

  useEffect(() => {
    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - startTime.current) / 1000);
      setElapsed(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);

      // Update per-agent timers
      setAgentTimers(() => {
        const timers: Record<string, string> = {};
        for (const [id, agent] of Object.entries(run.agents)) {
          if (agent.status === 'running') {
            timers[id] = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
          } else {
            timers[id] = agentTimers[id] ?? '';
          }
        }
        return timers;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [run.agents]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (focusedAgent) {
          setFocusedAgent(null);
        } else {
          run.cancel();
          onCancel();
        }
      }
      if (e.key === 'c' && e.ctrlKey) {
        run.cancel();
        onCancel();
      }
      const agentKeys = Object.keys(run.agents);
      if (['1', '2', '3'].includes(e.key) && agentKeys[Number(e.key) - 1]) {
        setFocusedAgent(agentKeys[Number(e.key) - 1]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusedAgent, run, onCancel]);

  useEffect(() => {
    if (run.stage !== 2) {
      setExpandedJuror(null);
    }
  }, [run.stage]);

  const agentEntries = Object.entries(run.agents);

  // Stage detail for progress bar
  const stageDetail = useMemo(() => {
    if (run.stage === 1) {
      const running = agentEntries.filter(([, a]) => a.status === 'running').length;
      const total = agentEntries.length;
      if (total > 0) return `${running}/${total} running`;
    }
    if (run.stage === 2) {
      const jurorEntries = Object.entries(run.jurors);
      const evaluating = jurorEntries.filter(([, j]) => j.status === 'evaluating').length;
      const total = jurorEntries.length;
      if (total > 0) return `${evaluating}/${total} evaluating`;
    }
    return undefined;
  }, [run.stage, agentEntries, run.jurors]);

  if (run.error) {
    return (
      <div className="flex flex-col h-screen bg-bg-page">
        <TitleBar subtitle="error" />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <svg className="w-10 h-10 text-red-error mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <span className="text-red-error text-sm font-medium block mb-3">Run failed</span>
            <div className="bg-red-error/10 border border-red-error/20 rounded-lg px-4 py-3 mb-6 text-left">
              <span className="text-red-error text-xs font-mono whitespace-pre-wrap">{run.error}</span>
            </div>
            <button onClick={onCancel} className="text-xs text-text-secondary hover:text-text-primary transition-colors">
              ← Return home
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-bg-page">
      <TitleBar subtitle={`running · ${elapsed}`} />
      <StageProgress 
        currentStage={run.stage} 
        viewStage={viewStage}
        stageDetail={stageDetail}
        onStageClick={setViewStage}
        maxViewableStage={maxViewableStage}
      />

      {/* Agent panes - Stage 1 */}
      {viewStage === 1 && (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Stage 1 header with raw details toggle */}
          <div className="flex items-center justify-end px-4 py-1.5 border-b border-border-primary/50 shrink-0 bg-bg-surface/30">
            <button
              onClick={() => setShowRawDetails(!showRawDetails)}
              className={`flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono rounded border transition-colors
                ${showRawDetails
                  ? 'border-green-primary/50 text-green-primary bg-green-primary/10'
                  : 'border-border-secondary text-text-muted hover:text-text-secondary hover:border-border-primary'
                }`}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
              {showRawDetails ? 'hide raw' : 'show raw'}
            </button>
          </div>
          <div className="flex-1 min-h-0 flex">
            {focusedAgent ? (
              <div className="flex-1 flex flex-col">
                {/* Tab bar for focused view */}
                <div className="flex items-center border-b border-border-primary shrink-0">
                  {agentEntries.map(([id, agent]) => (
                    <button
                      key={id}
                      onClick={() => setFocusedAgent(id)}
                      className={`flex items-center gap-2 px-4 py-2 text-xs font-mono border-b-2 transition-colors
                        ${id === focusedAgent
                          ? 'border-green-primary text-green-primary'
                          : 'border-transparent text-text-muted hover:text-text-secondary'
                        }`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full ${agent.status === 'running' ? 'bg-green-primary' : agent.status === 'error' ? 'bg-red-error' : 'bg-text-muted'}`} />
                      {agent.name}
                    </button>
                  ))}
                  <div className="flex-1" />
                  <button
                    onClick={() => setFocusedAgent(null)}
                    className="px-3 py-2 text-[10px] text-text-muted hover:text-text-secondary font-mono"
                  >
                    esc split view
                  </button>
                </div>
                <AgentPane
                  name={run.agents[focusedAgent]?.name ?? focusedAgent}
                  events={run.agents[focusedAgent]?.events ?? []}
                  status={run.agents[focusedAgent]?.status ?? 'queued'}
                  elapsed={agentTimers[focusedAgent]}
                  tokenUsage={run.agents[focusedAgent]?.tokenUsage}
                  showRawDetails={showRawDetails}
                  focused
                  onAbort={() => run.abortAgent(focusedAgent)}
                />
              </div>
            ) : (
              agentEntries.map(([id, agent], i) => (
                <div
                  key={id}
                  className={`flex-1 flex flex-col min-w-0 ${i > 0 ? 'border-l border-border-primary' : ''}`}
                >
                  <AgentPane
                    name={agent.name}
                    events={agent.events}
                    status={agent.status}
                    elapsed={agentTimers[id]}
                    tokenUsage={agent.tokenUsage}
                    showRawDetails={showRawDetails}
                    onClick={() => setFocusedAgent(id)}
                    onAbort={() => run.abortAgent(id)}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Stage 2: Juror grid */}
      {viewStage === 2 && (() => {
        const jurorEntries = Object.entries(run.jurors);
        const totalJurors = jurorEntries.length;
        const completeJurors = jurorEntries.filter(([, j]) => j.status === 'complete').length;
        const evaluatingJurors = jurorEntries.filter(([, j]) => j.status === 'evaluating').length;
        const progressPercent = totalJurors > 0 ? Math.round((completeJurors / totalJurors) * 100) : 0;

        // Calculate total tokens from all jurors
        const totalInputTokens = jurorEntries.reduce((sum, [, j]) => sum + (j.usage?.promptTokens ?? 0), 0);
        const totalOutputTokens = jurorEntries.reduce((sum, [, j]) => sum + (j.usage?.completionTokens ?? 0), 0);

        return (
          <div className="flex-1 min-h-0 flex flex-col">
            {/* Main scrollable content */}
            <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-6 pb-4">
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-green-primary text-sm font-medium">&gt;</span>
                <span className="text-text-primary text-sm font-medium">concilium in session</span>
                <span className="text-text-muted text-xs">// jurors evaluating agent responses</span>
              </div>
              <p className="text-text-tertiary text-[11px] font-mono mb-5">
                reviewing {agentEntries.filter(([, a]) => a.status === 'success').length} responses against prompt criteria · {totalJurors} jurors assigned
              </p>

              {/* Overall progress bar */}
              <div className="mb-6">
                <div className="flex justify-between text-[11px] font-mono text-text-muted mb-2">
                  <span>overall progress</span>
                  <span className="text-amber-warning">{progressPercent}%</span>
                </div>
                <div className="h-1.5 bg-bg-surface border border-border-primary/50 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-amber-warning transition-all duration-500 ease-out"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>

              {/* Juror cards grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {jurorEntries.map(([model, juror], i) => (
                  <JurorCard
                    key={model}
                    model={model}
                    juror={juror}
                    jurorLabel={`juror_${i + 1}`}
                    expanded={expandedJuror === model}
                    onToggleExpanded={() => {
                      setExpandedJuror((current) => (current === model ? null : model));
                    }}
                  />
                ))}
                {totalJurors === 0 && (
                  <div className="col-span-2 flex items-center justify-center py-16">
                    <div className="text-center">
                      <div className="w-6 h-6 border-2 border-amber-warning border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                      <span className="text-text-muted text-xs font-mono">Waiting for peer review to start...</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Fixed footer */}
            <div className="shrink-0 px-6 py-3 border-t border-border-primary/50 bg-bg-page">
              <div className="flex justify-between text-[11px] font-mono text-text-muted">
                <span>
                  progress: {completeJurors}/{totalJurors} complete · {evaluatingJurors}/{totalJurors} reviewing
                </span>
                {(totalInputTokens > 0 || totalOutputTokens > 0) && (
                  <span>
                    tokens: {totalInputTokens.toLocaleString()} in · {totalOutputTokens.toLocaleString()} out
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Stage 3: Synthesis */}
      {viewStage === 3 && !isComplete && (
        <div className="flex-1 min-h-0 flex items-center justify-center p-8">
          <div className="text-center">
            <div className="w-10 h-10 border-2 border-green-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <span className="text-text-primary text-sm font-medium block mb-2">Chairman synthesizing</span>
            <span className="text-text-muted text-xs font-mono">combining insights from all agents...</span>
          </div>
        </div>
      )}

      {/* Stage 4: Results/Leaderboard */}
      {viewStage === 4 && finalRecord && (
        <ResultsView record={finalRecord} onNewRun={onCancel} />
      )}

      {/* Stage Navigation Footer */}
      <div className="shrink-0 px-6 py-4 border-t border-white/5 bg-bg-page">
        <div className="flex items-center justify-between">
          {/* Step Indicators */}
          <div className="flex items-center gap-8">
            <button
              onClick={() => viewStage > 1 && setViewStage(viewStage - 1)}
              disabled={viewStage <= 1}
              className={`text-xs font-mono transition-colors flex items-center gap-2 ${
                viewStage > 1 
                  ? 'text-text-secondary hover:text-text-primary cursor-pointer' 
                  : 'text-text-muted cursor-not-allowed opacity-50'
              }`}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
              </svg>
              <span>Back</span>
            </button>

            <div className="flex items-center gap-4">
              {[1, 2, 3, 4].map((stage) => {
                const isViewing = viewStage === stage;
                const isCompleted = stage < run.stage || (stage === 4 && isComplete);
                const isViewable = stage <= maxViewableStage;
                
                return (
                  <button
                    key={stage}
                    onClick={() => isViewable && setViewStage(stage)}
                    disabled={!isViewable}
                    className={`flex items-center gap-2 text-xs font-mono transition-colors ${
                      isViewable ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                    }`}
                  >
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                      isViewing 
                        ? 'bg-green-primary text-bg-page' 
                        : isCompleted 
                          ? 'bg-green-primary/50 text-bg-page'
                          : 'border border-white/20 text-text-muted'
                    }`}>
                      {isCompleted ? '✓' : stage}
                    </span>
                    <span className={`tracking-wide ${
                      isViewing 
                        ? 'text-green-primary font-medium' 
                        : isCompleted 
                          ? 'text-text-secondary' 
                          : 'text-text-muted'
                    }`}>
                      {stage === 1 ? 'Compete' : stage === 2 ? 'Judge' : stage === 3 ? 'Synthesize' : 'Results'}
                    </span>
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => viewStage < maxViewableStage && setViewStage(viewStage + 1)}
              disabled={viewStage >= maxViewableStage}
              className={`text-xs font-mono transition-colors flex items-center gap-2 ${
                viewStage < maxViewableStage 
                  ? 'text-text-secondary hover:text-text-primary cursor-pointer' 
                  : 'text-text-muted cursor-not-allowed opacity-50'
              }`}
            >
              <span>Next</span>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Current Step Info */}
          <div className="text-[11px] text-text-muted font-mono">
            Step {viewStage} of 4
          </div>
        </div>
      </div>
    </div>
  );
}

// Results view component for Stage 4
interface ResultsViewProps {
  record: RunRecord;
  onNewRun: () => void;
}

function ResultsView({ record, onNewRun }: ResultsViewProps) {
  const [tab, setTab] = useState<'synthesis' | 'agents' | 'reviews'>('synthesis');
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [selectedReviewer, setSelectedReviewer] = useState(0);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const content = record.stage3?.response ?? '';
    await api.copyToClipboard(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [record]);

  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: 'synthesis', label: 'Synthesis' },
    { id: 'agents', label: `Agent Responses (${record.stage1.length})` },
    { id: 'reviews', label: `Peer Reviews (${record.stage2.length})` },
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Leaderboard */}
      <div className="px-6 py-3 border-b border-white/5">
        <Leaderboard rankings={record.metadata.aggregateRankings} />
      </div>

      {/* Tabs */}
      <div className="px-6 flex items-center justify-between border-b border-white/5 shrink-0">
        <div className="flex items-center gap-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-xs border-b-2 transition-colors font-mono tracking-wide
                ${tab === t.id
                  ? 'border-green-primary text-green-primary font-medium'
                  : 'border-transparent text-text-muted hover:text-text-secondary'
                }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </Button>
          <Button size="sm" variant="primary" onClick={onNewRun}>
            New Run
          </Button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'synthesis' && (
          <div className="p-6">
            {record.stage3 && (
              <>
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-text-muted text-[11px] font-mono">Chairman</span>
                  <Badge variant="green">{record.stage3.model}</Badge>
                </div>
                <MarkdownRenderer content={record.stage3.response} />
              </>
            )}
          </div>
        )}

        {tab === 'agents' && (
          <div className="flex h-full min-h-0">
            {/* Sidebar */}
            <div className="w-48 border-r border-white/5 overflow-y-auto shrink-0">
              {record.stage1.map((result, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedAgent(i)}
                  className={`w-full text-left px-4 py-3 text-xs border-b border-white/5 transition-colors font-mono
                    ${i === selectedAgent
                      ? 'bg-white/5 text-green-primary'
                      : 'text-text-secondary hover:bg-white/5'
                    }`}
                >
                  <span className="block truncate">{result.model}</span>
                </button>
              ))}
            </div>
            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {record.stage1[selectedAgent] && (
                <MarkdownRenderer content={record.stage1[selectedAgent].response} />
              )}
            </div>
          </div>
        )}

        {tab === 'reviews' && (
          <div className="flex h-full min-h-0">
            {/* Sidebar */}
            <div className="w-48 border-r border-white/5 overflow-y-auto shrink-0">
              {record.stage2.map((result, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedReviewer(i)}
                  className={`w-full text-left px-4 py-3 text-xs border-b border-white/5 transition-colors font-mono
                    ${i === selectedReviewer
                      ? 'bg-white/5 text-green-primary'
                      : 'text-text-secondary hover:bg-white/5'
                    }`}
                >
                  <span className="block truncate">{result.model}</span>
                </button>
              ))}
            </div>
            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {record.stage2[selectedReviewer] && (
                <>
                  {/* Extracted ranking */}
                  <div className="bg-bg-surface border border-white/5 rounded p-4 mb-4">
                    <h4 className="text-[11px] text-text-muted mb-2 font-mono tracking-wide">Extracted ranking</h4>
                    <div className="flex items-center gap-2 flex-wrap">
                      {record.stage2[selectedReviewer].parsedRanking.map((label, j) => {
                        const modelName = record.metadata.labelToModel[label] ?? label;
                        return (
                          <div key={j} className="flex items-center gap-1">
                            <span className="text-text-muted text-[10px] font-mono">{j + 1}.</span>
                            <Badge variant={j === 0 ? 'green' : 'muted'}>{modelName}</Badge>
                          </div>
                        );
                      })}
                      {record.stage2[selectedReviewer].parsedRanking.length === 0 && (
                        <span className="text-text-muted text-xs italic font-mono">No ranking extracted</span>
                      )}
                    </div>
                  </div>
                  {/* Full evaluation */}
                  <MarkdownRenderer content={record.stage2[selectedReviewer].ranking} />
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
