import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import type { ParsedEvent, RunRecord, AgentStatus, TokenUsage } from '../types';

export interface AgentState {
  id: string;
  name: string;
  status: AgentStatus;
  events: ParsedEvent[];
  textFragments: string[];
  tokenUsage: TokenUsage;
}

export type JurorStatus = 'evaluating' | 'complete' | 'failed';

export interface JurorUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface JurorState {
  status: JurorStatus;
  textContent: string;
  usage?: JurorUsage;
}

export interface CouncilRunState {
  stage: number;
  stageSummary: string;
  agents: Record<string, AgentState>;
  jurors: Record<string, JurorState>;
  result: RunRecord | null;
  error: string | null;
  isRunning: boolean;
}

function applyTokenUsage(existing: TokenUsage, parsed: ParsedEvent): TokenUsage {
  if (!parsed.tokenUsage) return existing;
  if (parsed.tokenUsageCumulative) {
    return { ...parsed.tokenUsage };
  }
  const prevCost = existing.totalCost ?? 0;
  const evtCost = parsed.tokenUsage.totalCost ?? 0;
  return {
    inputTokens: existing.inputTokens + parsed.tokenUsage.inputTokens,
    outputTokens: existing.outputTokens + parsed.tokenUsage.outputTokens,
    totalCost: (prevCost + evtCost) > 0 ? prevCost + evtCost : null,
  };
}

const EMPTY_TOKEN_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalCost: null };

export function useCouncilRun(
  runId: string | null,
  onComplete?: (record: RunRecord) => void,
  initialAgents?: Array<{ key: string; name: string }>,
) {
  const [state, setState] = useState<CouncilRunState>({
    stage: 0,
    stageSummary: '',
    agents: {},
    jurors: {},
    result: null,
    error: null,
    isRunning: false,
  });

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // --- rAF-throttled event batching ---
  // Buffer high-frequency agent events and juror chunks, flush once per frame.
  const pendingAgentEventsRef = useRef<Array<{ agentId: string; event: ParsedEvent }>>([]);
  const pendingJurorChunksRef = useRef<Array<{ model: string; chunk: string }>>([]);
  const flushRafRef = useRef(0);

  const flushPendingUpdates = useCallback(() => {
    flushRafRef.current = 0;

    const agentEvents = pendingAgentEventsRef.current;
    const jurorChunks = pendingJurorChunksRef.current;
    pendingAgentEventsRef.current = [];
    pendingJurorChunksRef.current = [];

    if (agentEvents.length === 0 && jurorChunks.length === 0) return;

    setState((prev) => {
      let agents = prev.agents;
      let jurors = prev.jurors;

      // Batch apply agent events — group by agentId first
      if (agentEvents.length > 0) {
        const grouped = new Map<string, ParsedEvent[]>();
        for (const { agentId, event } of agentEvents) {
          let list = grouped.get(agentId);
          if (!list) {
            list = [];
            grouped.set(agentId, list);
          }
          list.push(event);
        }

        for (const [agentId, events] of grouped) {
          const existing = agents[agentId] ?? {
            id: agentId,
            name: agentId,
            status: 'running' as AgentStatus,
            events: [],
            textFragments: [],
            tokenUsage: EMPTY_TOKEN_USAGE,
          };

          const newEvents = [...existing.events, ...events];
          const newFragments = [...existing.textFragments];
          let tokenUsage = existing.tokenUsage;
          const status = existing.status === 'queued' ? ('running' as AgentStatus) : existing.status;

          for (const parsed of events) {
            if (parsed.eventType === 'text') {
              newFragments.push(parsed.text);
            }
            tokenUsage = applyTokenUsage(tokenUsage, parsed);
          }

          agents = {
            ...agents,
            [agentId]: { ...existing, status, events: newEvents, textFragments: newFragments, tokenUsage },
          };
        }
      }

      // Batch apply juror chunks — merge per model
      if (jurorChunks.length > 0) {
        const grouped = new Map<string, string>();
        for (const { model, chunk } of jurorChunks) {
          grouped.set(model, (grouped.get(model) ?? '') + chunk);
        }

        for (const [model, combinedChunk] of grouped) {
          const existing = jurors[model];
          jurors = {
            ...jurors,
            [model]: {
              status: existing?.status ?? ('evaluating' as JurorStatus),
              textContent: (existing?.textContent ?? '') + combinedChunk,
              usage: existing?.usage,
            },
          };
        }
      }

      return { ...prev, agents, jurors };
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (!flushRafRef.current) {
      flushRafRef.current = requestAnimationFrame(flushPendingUpdates);
    }
  }, [flushPendingUpdates]);

  useEffect(() => {
    if (!runId) return;

    // Pre-populate agent entries from the initial data returned by run:start.
    // This avoids a race condition where agent:status IPC events are sent
    // before the renderer mounts this hook's listeners, causing all subsequent
    // agent:event messages to be silently dropped.
    const prePopulated: Record<string, AgentState> = {};
    if (initialAgents) {
      for (const agent of initialAgents) {
        prePopulated[agent.key] = {
          id: agent.key,
          name: agent.name,
          status: 'queued',
          events: [],
          textFragments: [],
          tokenUsage: EMPTY_TOKEN_USAGE,
        };
      }
    }

    setState({
      stage: 1,
      stageSummary: 'Competing — agents are generating responses',
      agents: prePopulated,
      jurors: {},
      result: null,
      error: null,
      isRunning: true,
    });

    const cleanups: Array<() => void> = [];

    // Status changes are infrequent — apply immediately (not throttled)
    cleanups.push(
      api.onAgentStatus((agentId: string, status: string, name?: string) => {
        // Flush buffered events (including token data) before terminal status
        // so token counts are applied before the UI renders the final state
        if (['success', 'error', 'aborted', 'cancelled'].includes(status)) {
          if (flushRafRef.current) {
            cancelAnimationFrame(flushRafRef.current);
            flushRafRef.current = 0;
          }
          flushPendingUpdates();
        }
        setState((prev) => ({
          ...prev,
          agents: {
            ...prev.agents,
            [agentId]: {
              ...prev.agents[agentId] ?? { id: agentId, name: name ?? agentId, events: [], textFragments: [], tokenUsage: EMPTY_TOKEN_USAGE },
              status: status as AgentStatus,
              name: name ?? prev.agents[agentId]?.name ?? agentId,
            },
          },
        }));
      }),
    );

    // High-frequency: buffer and flush via rAF
    cleanups.push(
      api.onAgentEvent((agentId: string, event: unknown) => {
        pendingAgentEventsRef.current.push({ agentId, event: event as ParsedEvent });
        scheduleFlush();
      }),
    );

    cleanups.push(
      api.onStageChange((stage: number, summary: string) => {
        setState((prev) => ({ ...prev, stage, stageSummary: summary }));
      }),
    );

    cleanups.push(
      api.onJurorStatus((model: string, status: string) => {
        const jurorStatus = status as JurorStatus;
        setState((prev) => ({
          ...prev,
          jurors: {
            ...prev.jurors,
            [model]: {
              status: jurorStatus,
              textContent: prev.jurors[model]?.textContent ?? '',
              usage: prev.jurors[model]?.usage,
            },
          },
        }));
      }),
    );

    // High-frequency: buffer and flush via rAF
    cleanups.push(
      api.onJurorChunk((model: string, chunk: string) => {
        if (!chunk) return;
        pendingJurorChunksRef.current.push({ model, chunk });
        scheduleFlush();
      }),
    );

    cleanups.push(
      api.onJurorUsage((model: string, usage: JurorUsage) => {
        setState((prev) => {
          const existing = prev.jurors[model];
          return {
            ...prev,
            jurors: {
              ...prev.jurors,
              [model]: {
                status: existing?.status ?? 'complete',
                textContent: existing?.textContent ?? '',
                usage,
              },
            },
          };
        });
      }),
    );

    cleanups.push(
      api.onRunComplete((record: unknown) => {
        const r = record as RunRecord;
        setState((prev) => ({ ...prev, result: r, isRunning: false }));
        onCompleteRef.current?.(r);
      }),
    );

    cleanups.push(
      api.onRunError((error: string) => {
        setState((prev) => ({ ...prev, error, isRunning: false }));
      }),
    );

    return () => {
      cleanups.forEach((fn) => fn());
      // Cancel any pending rAF flush
      if (flushRafRef.current) {
        cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = 0;
      }
    };
  }, [runId, scheduleFlush]);

  const cancel = useCallback(() => {
    if (runId) api.cancelRun(runId);
  }, [runId]);

  const abortAgent = useCallback((agentKey: string) => {
    if (runId) api.abortAgent(runId, agentKey);
  }, [runId]);

  return { ...state, cancel, abortAgent };
}
