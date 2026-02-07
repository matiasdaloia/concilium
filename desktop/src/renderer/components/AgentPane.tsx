import { useRef, useEffect, useMemo } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import type { ParsedEvent, TokenUsage } from '../types';

interface AgentPaneProps {
  name: string;
  events: ParsedEvent[];
  status: string;
  elapsed?: string;
  tokenUsage?: TokenUsage;
  focused?: boolean;
  onClick?: () => void;
  showRawDetails?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** Group consecutive text events into markdown blocks, keep others as individual items */
type StreamChunk =
  | { kind: 'markdown'; content: string }
  | { kind: 'tool'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'status'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'raw'; text: string };

function groupEvents(events: ParsedEvent[], showRawDetails: boolean): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  let mdBuffer = '';

  const flushMd = () => {
    if (mdBuffer) {
      chunks.push({ kind: 'markdown', content: mdBuffer });
      mdBuffer = '';
    }
  };

  for (const ev of events) {
    switch (ev.eventType) {
      case 'text':
        mdBuffer += ev.text;
        break;
      case 'tool_call':
        flushMd();
        chunks.push({ kind: 'tool', text: ev.text });
        break;
      case 'thinking':
        flushMd();
        chunks.push({ kind: 'thinking', text: ev.text });
        break;
      case 'status':
        flushMd();
        chunks.push({ kind: 'status', text: ev.text });
        break;
      default: {
        flushMd();
        // Check if it looks like an error
        const lower = ev.rawLine?.toLowerCase() ?? '';
        if (lower.includes('error') || lower.includes('fail')) {
          chunks.push({ kind: 'error', text: ev.text || ev.rawLine });
        } else if (showRawDetails) {
          // Only show raw chunks when showRawDetails is enabled
          chunks.push({ kind: 'raw', text: ev.text || ev.rawLine });
        }
        // When showRawDetails is false, raw events are silently skipped
      }
    }
  }
  flushMd();
  return chunks;
}

export default function AgentPane({ name, events, status, elapsed, tokenUsage, focused, onClick, showRawDetails = false }: AgentPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const chunks = useMemo(() => groupEvents(events, showRawDetails), [events, showRawDetails]);

  const isRunning = status === 'running';
  const isError = status === 'error';
  const isDone = status === 'success';

  return (
    <div
      className={`flex flex-col min-h-0 h-full ${focused ? '' : 'cursor-pointer hover:bg-bg-hover/20'}`}
      onClick={onClick}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-10 shrink-0 border-b border-border-primary">
        <div className="flex items-center gap-2">
          {isDone ? (
            <svg className="w-3.5 h-3.5 text-green-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : isError ? (
            <svg className="w-3.5 h-3.5 text-red-error shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          ) : (
            <div className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-green-primary animate-pulse' : 'bg-text-muted'}`} />
          )}
          <span className="text-[13px] font-medium text-text-primary font-mono">{name}</span>
          <span className={`text-[11px] font-mono ${isError ? 'text-red-error' : isRunning ? 'text-green-primary' : isDone ? 'text-green-primary' : 'text-text-muted'}`}>
            {status}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {tokenUsage && (tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0) && (
            <span className="text-[10px] text-text-muted font-mono">
              {formatTokens(tokenUsage.inputTokens)}↑ {formatTokens(tokenUsage.outputTokens)}↓
              {tokenUsage.totalCost ? ` · ${formatCost(tokenUsage.totalCost)}` : ''}
            </span>
          )}
          {elapsed && <span className="text-[11px] text-text-tertiary font-mono">{elapsed}</span>}
        </div>
      </div>

      {/* Content stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 min-h-0">
        {chunks.map((chunk, i) => {
          switch (chunk.kind) {
            case 'markdown':
              return <MarkdownRenderer key={i} content={chunk.content} className="text-[11px]" />;
            case 'tool':
              return (
                <div key={i} className="flex items-start gap-2 py-0.5 font-mono text-[11px] leading-relaxed">
                  <span className="text-blue-info shrink-0">▸</span>
                  <span className="text-blue-info">{chunk.text}</span>
                </div>
              );
            case 'thinking':
              return (
                <div key={i} className="py-0.5 [&_.markdown-content]:italic [&_.markdown-content_*]:!text-amber-warning">
                  <MarkdownRenderer content={chunk.text} className="text-[11px]" />
                </div>
              );
            case 'status':
              return (
                <div key={i} className="py-0.5 font-mono text-[11px] text-text-muted leading-relaxed">
                  {chunk.text}
                </div>
              );
            case 'error':
              return (
                <div key={i} className="py-1 px-3 my-1 rounded bg-red-error/10 border border-red-error/20 font-mono text-[11px] text-red-error leading-relaxed">
                  {chunk.text}
                </div>
              );
            case 'raw':
              return (
                <div key={i} className="py-0.5 font-mono text-[11px] text-text-muted/60 leading-relaxed">
                  {chunk.text}
                </div>
              );
          }
        })}
        {chunks.length === 0 && (
          <span className="text-text-muted text-[11px] font-mono italic">Waiting for output...</span>
        )}
        {/* Blinking cursor when running */}
        {isRunning && chunks.length > 0 && (
          <span className="inline-block w-2 h-4 bg-green-primary animate-pulse mt-1" />
        )}
      </div>
    </div>
  );
}
