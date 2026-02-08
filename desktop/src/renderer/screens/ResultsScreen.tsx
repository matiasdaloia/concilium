import { useState, useCallback, useMemo } from 'react';
import TitleBar from '../components/TitleBar';
import Leaderboard from '../components/Leaderboard';
import MarkdownRenderer from '../components/MarkdownRenderer';
import Button from '../components/Button';
import Badge from '../components/Badge';
import { api } from '../api';
import type { RunRecord, TokenUsage, CouncilTokenUsage, ParsedEvent } from '../types';

type Tab = 'synthesis' | 'agents' | 'reviews' | 'report';

interface ResultsScreenProps {
  record: RunRecord;
  onNewRun: () => void;
}

export default function ResultsScreen({ record, onNewRun }: ResultsScreenProps) {
  const [tab, setTab] = useState<Tab>('synthesis');
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [selectedReviewer, setSelectedReviewer] = useState(0);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const content = record.stage3?.response ?? '';
    await api.copyToClipboard(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [record]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'synthesis', label: 'Synthesis' },
    { id: 'agents', label: `Agent Responses (${record.stage1.length})` },
    { id: 'reviews', label: `Peer Reviews (${record.stage2.length})` },
    { id: 'report', label: 'Run Report' },
  ];

  return (
    <div className="flex flex-col h-screen">
      <TitleBar subtitle="results" />

      {/* Leaderboard */}
      <div className="px-6 py-3">
        <Leaderboard rankings={record.metadata.aggregateRankings} />
      </div>

      {/* Tabs */}
      <div className="px-6 flex items-center justify-between border-b border-border-primary">
        <div className="flex items-center gap-0">
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
                  <span className="text-text-muted text-[10px] uppercase tracking-wider">Chairman</span>
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
            <div className="w-48 border-r border-border-primary overflow-y-auto shrink-0">
              {record.stage1.map((result, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedAgent(i)}
                  className={`w-full text-left px-4 py-3 text-xs border-b border-border-primary transition-colors
                    ${i === selectedAgent
                      ? 'bg-bg-hover text-green-primary'
                      : 'text-text-secondary hover:bg-bg-surface'
                    }`}
                >
                  <span className="block truncate font-medium">{result.model}</span>
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
            <div className="w-48 border-r border-border-primary overflow-y-auto shrink-0">
              {record.stage2.map((result, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedReviewer(i)}
                  className={`w-full text-left px-4 py-3 text-xs border-b border-border-primary transition-colors
                    ${i === selectedReviewer
                      ? 'bg-bg-hover text-green-primary'
                      : 'text-text-secondary hover:bg-bg-surface'
                    }`}
                >
                  <span className="block truncate font-medium">{result.model}</span>
                </button>
              ))}
            </div>
            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {record.stage2[selectedReviewer] && (
                <>
                  {/* Extracted ranking */}
                  <div className="bg-bg-surface border border-border-primary rounded-lg p-4 mb-4">
                    <h4 className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Extracted Ranking</h4>
                    <div className="flex items-center gap-2 flex-wrap">
                      {record.stage2[selectedReviewer].parsedRanking.map((label, j) => {
                        const modelName = record.metadata.labelToModel[label] ?? label;
                        return (
                          <div key={j} className="flex items-center gap-1">
                            <span className="text-text-muted text-[10px]">{j + 1}.</span>
                            <Badge variant={j === 0 ? 'green' : 'muted'}>{modelName}</Badge>
                          </div>
                        );
                      })}
                      {record.stage2[selectedReviewer].parsedRanking.length === 0 && (
                        <span className="text-text-muted text-xs italic">No ranking extracted</span>
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

        {tab === 'report' && <RunReport record={record} />}
      </div>
    </div>
  );
}

// ─── Run Report Component ────────────────────────────────────────────────────

function extractTokenUsage(events: ParsedEvent[]): TokenUsage {
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalCost: null };
  for (const ev of events) {
    if (!ev.tokenUsage) continue;
    if (ev.tokenUsageCumulative) {
      usage = { ...ev.tokenUsage };
    } else {
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

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(cost: number | null | undefined): string {
  if (!cost || cost === 0) return '—';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function fmtDuration(startedAt?: string | null, endedAt?: string | null): string {
  if (!startedAt || !endedAt) return '—';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (isNaN(ms) || ms < 0) return '—';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function RunReport({ record }: { record: RunRecord }) {
  const report = useMemo(() => {
    // Agent stats
    const agentStats = record.agents.map((agent) => {
      const usage = extractTokenUsage(agent.events);
      return {
        name: agent.name,
        status: agent.status,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cost: usage.totalCost ?? 0,
        duration: fmtDuration(agent.startedAt, agent.endedAt),
      };
    });

    // Juror stats
    const jurorStats = record.stage2.map((s2) => ({
      model: s2.model,
      promptTokens: s2.usage?.promptTokens ?? 0,
      completionTokens: s2.usage?.completionTokens ?? 0,
      totalTokens: s2.usage?.totalTokens ?? 0,
      hasUsage: !!s2.usage,
      duration: fmtDuration(s2.startedAt, s2.endedAt),
    }));

    // Chairman stats
    const chairmanUsage = record.stage3?.usage;
    const chairmanStats = record.stage3 ? {
      model: record.stage3.model,
      promptTokens: chairmanUsage?.promptTokens ?? 0,
      completionTokens: chairmanUsage?.completionTokens ?? 0,
      totalTokens: chairmanUsage?.totalTokens ?? 0,
      hasUsage: !!chairmanUsage,
      duration: fmtDuration(record.stage3.startedAt, record.stage3.endedAt),
    } : null;

    // Totals
    const totalAgentInput = agentStats.reduce((s, a) => s + a.inputTokens, 0);
    const totalAgentOutput = agentStats.reduce((s, a) => s + a.outputTokens, 0);
    const totalAgentCost = agentStats.reduce((s, a) => s + a.cost, 0);

    const totalJurorPrompt = jurorStats.reduce((s, j) => s + j.promptTokens, 0);
    const totalJurorCompletion = jurorStats.reduce((s, j) => s + j.completionTokens, 0);

    const totalChairmanPrompt = chairmanStats?.promptTokens ?? 0;
    const totalChairmanCompletion = chairmanStats?.completionTokens ?? 0;

    const grandTotalTokens = totalAgentInput + totalAgentOutput
      + totalJurorPrompt + totalJurorCompletion
      + totalChairmanPrompt + totalChairmanCompletion;

    return {
      agentStats,
      jurorStats,
      chairmanStats,
      totalAgentInput,
      totalAgentOutput,
      totalAgentCost,
      totalJurorPrompt,
      totalJurorCompletion,
      totalChairmanPrompt,
      totalChairmanCompletion,
      grandTotalTokens,
    };
  }, [record]);

  const maxAgentTokens = Math.max(
    ...report.agentStats.map(a => a.inputTokens + a.outputTokens),
    1,
  );

  return (
    <div className="p-6 space-y-6">
      {/* Grand Total Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-bg-surface border border-border-primary rounded-lg p-4">
          <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Total Tokens (All Stages)</div>
          <div className="text-2xl font-bold font-mono text-green-primary">{fmtTokens(report.grandTotalTokens)}</div>
        </div>
        <div className="bg-bg-surface border border-border-primary rounded-lg p-4">
          <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Agent Tokens (Stage 1)</div>
          <div className="text-2xl font-bold font-mono text-blue-info">
            {fmtTokens(report.totalAgentInput + report.totalAgentOutput)}
          </div>
          <div className="text-[10px] text-text-tertiary mt-1">
            {fmtTokens(report.totalAgentInput)} in · {fmtTokens(report.totalAgentOutput)} out
          </div>
        </div>
        <div className="bg-bg-surface border border-border-primary rounded-lg p-4">
          <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Council Tokens (Stage 2+3)</div>
          <div className="text-2xl font-bold font-mono text-amber-warning">
            {fmtTokens(
              report.totalJurorPrompt + report.totalJurorCompletion +
              report.totalChairmanPrompt + report.totalChairmanCompletion
            )}
          </div>
          <div className="text-[10px] text-text-tertiary mt-1">
            {report.jurorStats.length} jurors + 1 chairman
          </div>
        </div>
        <div className="bg-bg-surface border border-border-primary rounded-lg p-4">
          <div className="text-[10px] text-text-muted uppercase tracking-wider mb-2">Agent Cost</div>
          <div className="text-2xl font-bold font-mono text-text-primary">{fmtCost(report.totalAgentCost)}</div>
        </div>
      </div>

      {/* Stage 1: Agent Breakdown */}
      <div className="bg-bg-surface border border-border-primary rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-border-primary flex items-center gap-2">
          <Badge variant="blue">Stage 1</Badge>
          <h3 className="text-xs font-medium text-text-secondary tracking-wide">Agent Execution</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="border-b border-border-primary text-text-muted">
                <th className="text-left px-5 py-2.5 font-medium">Agent</th>
                <th className="text-center px-3 py-2.5 font-medium">Status</th>
                <th className="text-right px-3 py-2.5 font-medium">Input</th>
                <th className="text-right px-3 py-2.5 font-medium">Output</th>
                <th className="text-right px-3 py-2.5 font-medium">Cost</th>
                <th className="text-right px-3 py-2.5 font-medium">Duration</th>
                <th className="px-5 py-2.5 font-medium w-32">Usage</th>
              </tr>
            </thead>
            <tbody>
              {report.agentStats.map((agent, i) => {
                const totalTok = agent.inputTokens + agent.outputTokens;
                const barPct = maxAgentTokens > 0 ? (totalTok / maxAgentTokens) * 100 : 0;
                return (
                  <tr key={i} className="border-b border-border-primary/50">
                    <td className="px-5 py-2.5 text-text-primary font-medium truncate max-w-[200px]" title={agent.name}>
                      {agent.name}
                    </td>
                    <td className="text-center px-3 py-2.5">
                      <Badge variant={agent.status === 'success' ? 'green' : agent.status === 'error' ? 'red' : 'muted'}>
                        {agent.status}
                      </Badge>
                    </td>
                    <td className="text-right px-3 py-2.5 text-blue-info">{fmtTokens(agent.inputTokens)}</td>
                    <td className="text-right px-3 py-2.5 text-green-primary">{fmtTokens(agent.outputTokens)}</td>
                    <td className="text-right px-3 py-2.5 text-amber-warning">{fmtCost(agent.cost)}</td>
                    <td className="text-right px-3 py-2.5 text-text-secondary">{agent.duration}</td>
                    <td className="px-5 py-2.5">
                      <div className="h-2 bg-border-primary/30 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-blue-info/50" style={{ width: `${barPct}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Stage 2: Juror Breakdown */}
      {report.jurorStats.length > 0 && (
        <div className="bg-bg-surface border border-border-primary rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-border-primary flex items-center gap-2">
            <Badge variant="amber">Stage 2</Badge>
            <h3 className="text-xs font-medium text-text-secondary tracking-wide">Juror Peer Review</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="border-b border-border-primary text-text-muted">
                  <th className="text-left px-5 py-2.5 font-medium">Juror Model</th>
                  <th className="text-right px-3 py-2.5 font-medium">Prompt Tokens</th>
                  <th className="text-right px-3 py-2.5 font-medium">Completion Tokens</th>
                  <th className="text-right px-3 py-2.5 font-medium">Total Tokens</th>
                  <th className="text-right px-5 py-2.5 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {report.jurorStats.map((juror, i) => (
                  <tr key={i} className="border-b border-border-primary/50">
                    <td className="px-5 py-2.5 text-text-primary font-medium truncate max-w-[250px]" title={juror.model}>
                      {juror.model}
                    </td>
                    {juror.hasUsage ? (
                      <>
                        <td className="text-right px-3 py-2.5 text-blue-info">{fmtTokens(juror.promptTokens)}</td>
                        <td className="text-right px-3 py-2.5 text-green-primary">{fmtTokens(juror.completionTokens)}</td>
                        <td className="text-right px-3 py-2.5 text-text-secondary">{fmtTokens(juror.totalTokens)}</td>
                      </>
                    ) : (
                      <td colSpan={3} className="text-right px-3 py-2.5 text-text-muted italic">
                        Usage data not available for this run
                      </td>
                    )}
                    <td className="text-right px-5 py-2.5 text-text-secondary">{juror.duration}</td>
                  </tr>
                ))}
                {/* Juror totals */}
                <tr className="border-t border-border-primary bg-bg-page/30">
                  <td className="px-5 py-2.5 text-text-muted font-medium">Total (Jurors)</td>
                  <td className="text-right px-3 py-2.5 text-blue-info font-medium">{fmtTokens(report.totalJurorPrompt)}</td>
                  <td className="text-right px-3 py-2.5 text-green-primary font-medium">{fmtTokens(report.totalJurorCompletion)}</td>
                  <td className="text-right px-3 py-2.5 text-text-primary font-medium">
                    {fmtTokens(report.totalJurorPrompt + report.totalJurorCompletion)}
                  </td>
                  <td className="text-right px-5 py-2.5 text-text-muted">—</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Stage 3: Chairman */}
      {report.chairmanStats && (
        <div className="bg-bg-surface border border-border-primary rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-border-primary flex items-center gap-2">
            <Badge variant="green">Stage 3</Badge>
            <h3 className="text-xs font-medium text-text-secondary tracking-wide">Chairman Synthesis</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="border-b border-border-primary text-text-muted">
                  <th className="text-left px-5 py-2.5 font-medium">Chairman Model</th>
                  <th className="text-right px-3 py-2.5 font-medium">Prompt Tokens</th>
                  <th className="text-right px-3 py-2.5 font-medium">Completion Tokens</th>
                  <th className="text-right px-3 py-2.5 font-medium">Total Tokens</th>
                  <th className="text-right px-5 py-2.5 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border-primary/50">
                  <td className="px-5 py-2.5 text-text-primary font-medium truncate max-w-[250px]" title={report.chairmanStats.model}>
                    {report.chairmanStats.model}
                  </td>
                  {report.chairmanStats.hasUsage ? (
                    <>
                      <td className="text-right px-3 py-2.5 text-blue-info">{fmtTokens(report.chairmanStats.promptTokens)}</td>
                      <td className="text-right px-3 py-2.5 text-green-primary">{fmtTokens(report.chairmanStats.completionTokens)}</td>
                      <td className="text-right px-3 py-2.5 text-text-secondary">{fmtTokens(report.chairmanStats.totalTokens)}</td>
                    </>
                  ) : (
                    <td colSpan={3} className="text-right px-3 py-2.5 text-text-muted italic">
                      Usage data not available for this run
                    </td>
                  )}
                  <td className="text-right px-5 py-2.5 text-text-secondary">{report.chairmanStats.duration}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Token Distribution Visual */}
      <div className="bg-bg-surface border border-border-primary rounded-lg p-5">
        <h3 className="text-xs font-medium text-text-secondary mb-1 tracking-wide">Token Distribution by Stage</h3>
        <p className="text-[10px] text-text-muted mb-4">Proportion of tokens used across the pipeline</p>
        {(() => {
          const agentTotal = report.totalAgentInput + report.totalAgentOutput;
          const jurorTotal = report.totalJurorPrompt + report.totalJurorCompletion;
          const chairmanTotal = report.totalChairmanPrompt + report.totalChairmanCompletion;
          const total = agentTotal + jurorTotal + chairmanTotal;
          if (total === 0) {
            return <div className="text-text-muted text-xs font-mono text-center py-4">No token data available</div>;
          }
          const agentPct = (agentTotal / total) * 100;
          const jurorPct = (jurorTotal / total) * 100;
          const chairmanPct = (chairmanTotal / total) * 100;
          return (
            <div className="space-y-3">
              <div className="h-8 rounded overflow-hidden flex">
                {agentPct > 0 && (
                  <div
                    className="bg-blue-info/50 flex items-center justify-center text-[10px] font-mono text-white"
                    style={{ width: `${agentPct}%` }}
                  >
                    {agentPct > 12 ? `Agents ${agentPct.toFixed(0)}%` : ''}
                  </div>
                )}
                {jurorPct > 0 && (
                  <div
                    className="bg-amber-warning/50 flex items-center justify-center text-[10px] font-mono text-white"
                    style={{ width: `${jurorPct}%` }}
                  >
                    {jurorPct > 12 ? `Jurors ${jurorPct.toFixed(0)}%` : ''}
                  </div>
                )}
                {chairmanPct > 0 && (
                  <div
                    className="bg-green-primary/50 flex items-center justify-center text-[10px] font-mono text-white"
                    style={{ width: `${chairmanPct}%` }}
                  >
                    {chairmanPct > 12 ? `Chairman ${chairmanPct.toFixed(0)}%` : ''}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-6 text-[10px] font-mono text-text-muted">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm bg-blue-info/50" />
                  Agents: {fmtTokens(agentTotal)} ({agentPct.toFixed(1)}%)
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm bg-amber-warning/50" />
                  Jurors: {fmtTokens(jurorTotal)} ({jurorPct.toFixed(1)}%)
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm bg-green-primary/50" />
                  Chairman: {fmtTokens(chairmanTotal)} ({chairmanPct.toFixed(1)}%)
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
