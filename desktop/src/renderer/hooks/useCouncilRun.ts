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
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalCost: null },
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

    cleanups.push(
      api.onAgentStatus((agentId: string, status: string, name?: string) => {
        setState((prev) => ({
          ...prev,
          agents: {
            ...prev.agents,
            [agentId]: {
              ...prev.agents[agentId] ?? { id: agentId, name: name ?? agentId, events: [], textFragments: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalCost: null } },
              status: status as AgentStatus,
              // Update name if provided (first status event will have it)
              name: name ?? prev.agents[agentId]?.name ?? agentId,
            },
          },
        }));
      }),
    );

    cleanups.push(
      api.onAgentEvent((agentId: string, event: unknown) => {
        const parsed = event as ParsedEvent;
        setState((prev) => {
          // Use pre-populated entry if available (from initialAgents), otherwise
          // auto-create a fallback entry so events are never silently dropped.
          const existing = prev.agents[agentId] ?? {
            id: agentId,
            name: agentId,
            status: 'running' as AgentStatus,
            events: [],
            textFragments: [],
            tokenUsage: { inputTokens: 0, outputTokens: 0, totalCost: null },
          };

          // If agent was queued but we're receiving events, it's now running
          const status = existing.status === 'queued' ? 'running' : existing.status;
          const newFragments = parsed.eventType === 'text'
            ? [...existing.textFragments, parsed.text]
            : existing.textFragments;

          // Update token usage from events that carry it
          let tokenUsage = existing.tokenUsage;
          if (parsed.tokenUsage) {
            if (parsed.tokenUsageCumulative) {
              // Cumulative: replace with the latest total (Claude result, Codex turn.completed)
              tokenUsage = { ...parsed.tokenUsage };
            } else {
              // Incremental: sum with previous (OpenCode step_finish)
              const prevCost = tokenUsage.totalCost ?? 0;
              const evtCost = parsed.tokenUsage.totalCost ?? 0;
              tokenUsage = {
                inputTokens: tokenUsage.inputTokens + parsed.tokenUsage.inputTokens,
                outputTokens: tokenUsage.outputTokens + parsed.tokenUsage.outputTokens,
                totalCost: (prevCost + evtCost) > 0 ? prevCost + evtCost : null,
              };
            }
          }

          return {
            ...prev,
            agents: {
              ...prev.agents,
              [agentId]: {
                ...existing,
                status,
                events: [...existing.events, parsed],
                textFragments: newFragments,
                tokenUsage,
              },
            },
          };
        });
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

    cleanups.push(
      api.onJurorChunk((model: string, chunk: string) => {
        if (!chunk) return;
        setState((prev) => {
          const existing = prev.jurors[model];
          return {
            ...prev,
            jurors: {
              ...prev.jurors,
              [model]: {
                status: existing?.status ?? 'evaluating',
                textContent: (existing?.textContent ?? '') + chunk,
                usage: existing?.usage,
              },
            },
          };
        });
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
    };
  }, [runId]);

  const cancel = useCallback(() => {
    if (runId) api.cancelRun(runId);
  }, [runId]);

  const abortAgent = useCallback((agentKey: string) => {
    if (runId) api.abortAgent(runId, agentKey);
  }, [runId]);

  return { ...state, cancel, abortAgent };
}
