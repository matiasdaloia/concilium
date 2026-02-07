import { useState, useCallback } from 'react';
import TitleBar from '../components/TitleBar';
import Leaderboard from '../components/Leaderboard';
import MarkdownRenderer from '../components/MarkdownRenderer';
import Button from '../components/Button';
import Badge from '../components/Badge';
import { api } from '../api';
import type { RunRecord } from '../types';

type Tab = 'synthesis' | 'agents' | 'reviews';

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
      </div>
    </div>
  );
}
