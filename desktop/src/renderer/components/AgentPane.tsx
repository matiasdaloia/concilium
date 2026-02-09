import { memo, useRef, useMemo } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import { useSmartScroll } from '../hooks/useSmartScroll';
import type { ParsedEvent, TokenUsage } from '../types';

interface AgentPaneProps {
  name: string;
  events: ParsedEvent[];
  status: string;
  elapsed?: string;
  tokenUsage?: TokenUsage;
  focused?: boolean;
  onClick?: () => void;
  onAbort?: () => void;
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
  let thinkingBuffer = '';

  const flushMd = () => {
    if (mdBuffer) {
      chunks.push({ kind: 'markdown', content: mdBuffer });
      mdBuffer = '';
    }
  };

  const flushThinking = () => {
    if (thinkingBuffer) {
      chunks.push({ kind: 'thinking', text: thinkingBuffer });
      thinkingBuffer = '';
    }
  };

  const flushAll = () => {
    flushMd();
    flushThinking();
  };

  for (const ev of events) {
    switch (ev.eventType) {
      case 'text':
        flushThinking();
        mdBuffer += ev.text;
        break;
      case 'thinking':
        flushMd();
        thinkingBuffer += ev.text;
        break;
      case 'tool_call':
        flushAll();
        chunks.push({ kind: 'tool', text: ev.text });
        break;
      case 'status':
        flushAll();
        chunks.push({ kind: 'status', text: ev.text });
        break;
      default: {
        flushAll();
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
  flushAll();
  return chunks;
}

/**
 * Incrementally group events: only process newly appended events and merge
 * into the existing chunk list. Falls back to full recompute if showRawDetails
 * changes or events were reset (e.g. different agent).
 */
function useIncrementalChunks(events: ParsedEvent[], showRawDetails: boolean): StreamChunk[] {
  const cacheRef = useRef<{
    chunks: StreamChunk[];
    processedCount: number;
    showRaw: boolean;
  }>({ chunks: [], processedCount: 0, showRaw: false });

  return useMemo(() => {
    const cache = cacheRef.current;

    // Full recompute if showRawDetails toggled or events were replaced/reset
    if (cache.showRaw !== showRawDetails || events.length < cache.processedCount) {
      const result = groupEvents(events, showRawDetails);
      cacheRef.current = { chunks: result, processedCount: events.length, showRaw: showRawDetails };
      return result;
    }

    // No new events → return cached
    if (events.length === cache.processedCount) {
      return cache.chunks;
    }

    // Process only new events
    const newEvents = events.slice(cache.processedCount);
    const chunks = [...cache.chunks];

    // Resume buffers from the last cached chunk if the first new event
    // continues the same kind, so we extend rather than create a new chunk.
    let mdBuffer = '';
    let thinkingBuffer = '';
    const firstKind = newEvents[0]?.eventType;
    if (chunks.length > 0) {
      const last = chunks[chunks.length - 1];
      if (last.kind === 'markdown' && firstKind === 'text') {
        chunks.pop();
        mdBuffer = last.content;
      } else if (last.kind === 'thinking' && firstKind === 'thinking') {
        chunks.pop();
        thinkingBuffer = last.text;
      }
    }

    const flushMd = () => {
      if (mdBuffer) {
        chunks.push({ kind: 'markdown', content: mdBuffer });
        mdBuffer = '';
      }
    };
    const flushThinking = () => {
      if (thinkingBuffer) {
        chunks.push({ kind: 'thinking', text: thinkingBuffer });
        thinkingBuffer = '';
      }
    };
    const flushAll = () => { flushMd(); flushThinking(); };

    for (const ev of newEvents) {
      switch (ev.eventType) {
        case 'text':
          flushThinking();
          mdBuffer += ev.text;
          break;
        case 'thinking':
          flushMd();
          thinkingBuffer += ev.text;
          break;
        case 'tool_call':
          flushAll();
          chunks.push({ kind: 'tool', text: ev.text });
          break;
        case 'status':
          flushAll();
          chunks.push({ kind: 'status', text: ev.text });
          break;
        default: {
          flushAll();
          const lower = ev.rawLine?.toLowerCase() ?? '';
          if (lower.includes('error') || lower.includes('fail')) {
            chunks.push({ kind: 'error', text: ev.text || ev.rawLine });
          } else if (showRawDetails) {
            chunks.push({ kind: 'raw', text: ev.text || ev.rawLine });
          }
        }
      }
    }
    flushAll();

    cacheRef.current = { chunks, processedCount: events.length, showRaw: showRawDetails };
    return chunks;
  }, [events, showRawDetails]);
}

export default memo(function AgentPane({ name, events, status, elapsed, tokenUsage, focused, onClick, onAbort, showRawDetails = false }: AgentPaneProps) {
  const chunks = useIncrementalChunks(events, showRawDetails);

  const { scrollRef, showScrollButton, scrollToBottom } = useSmartScroll(chunks);

  const isRunning = status === 'running';
  const isError = status === 'error';
  const isAborted = status === 'aborted';
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
          ) : isError || isAborted ? (
            <svg className="w-3.5 h-3.5 text-red-error shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          ) : (
            <div className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-green-primary animate-pulse' : 'bg-text-muted'}`} />
          )}
          <span className="text-[13px] font-medium text-text-primary font-mono">{name}</span>
          <span className={`text-[11px] font-mono ${isError || isAborted ? 'text-red-error' : isRunning ? 'text-green-primary' : isDone ? 'text-green-primary' : 'text-text-muted'}`}>
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
          {isRunning && onAbort && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAbort();
              }}
              className="text-[10px] text-red-error hover:text-red-error/80 font-mono px-2 py-0.5 border border-red-error/30 rounded hover:bg-red-error/10 transition-colors"
              title="Abort this agent"
            >
              abort
            </button>
          )}
        </div>
      </div>

      {/* Content stream */}
      <div className="relative flex-1 min-h-0">
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto p-4">
          {chunks.map((chunk, i) => {
            switch (chunk.kind) {
              case 'markdown':
                return <MarkdownRenderer key={i} content={chunk.content} className="text-[11px]" streaming={isRunning} />;
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
                    <MarkdownRenderer content={chunk.text} className="text-[11px]" streaming={isRunning} />
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
        {/* Scroll-to-bottom indicator */}
        {showScrollButton && isRunning && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              scrollToBottom();
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bg-surface/90 border border-border-primary shadow-lg text-[10px] font-mono text-text-secondary hover:text-text-primary hover:border-green-primary/50 transition-colors backdrop-blur-sm"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
            New output
          </button>
        )}
      </div>
    </div>
  );
});
