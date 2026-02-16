import { useReducer, useEffect, useRef } from 'react';
import type {
  AgentStatus,
  ParsedEvent,
  CouncilTokenUsage,
  AggregateRanking,
  RunRecord,
} from '@concilium/core';
import type { EventHandler } from '../../adapters/callback-event-bridge.js';

export interface AgentState {
  key: string;
  name: string;
  status: AgentStatus;
  eventCount: number;
  startedAt?: number;
}

export interface JurorState {
  model: string;
  status: string;
  chunkCount: number;
}

export interface DeliberationState {
  stage: number;
  stageSummary: string;
  agents: Map<string, AgentState>;
  jurors: Map<string, JurorState>;
  rankings: AggregateRanking[];
  record: RunRecord | null;
  error: string | null;
  done: boolean;
}

export type Action =
  | { type: 'STAGE_CHANGE'; stage: number; summary: string }
  | { type: 'AGENT_STATUS'; key: string; status: AgentStatus; name?: string }
  | { type: 'AGENT_EVENT'; key: string; event: ParsedEvent }
  | { type: 'JUROR_STATUS'; model: string; status: string }
  | { type: 'JUROR_CHUNK'; model: string }
  | { type: 'JUROR_COMPLETE'; model: string; success: boolean; usage?: CouncilTokenUsage }
  | { type: 'SYNTHESIS_START' }
  | { type: 'COMPLETE'; record: RunRecord }
  | { type: 'ERROR'; error: string };

export function deliberationReducer(state: DeliberationState, action: Action): DeliberationState {
  switch (action.type) {
    case 'STAGE_CHANGE':
      return { ...state, stage: action.stage, stageSummary: action.summary };

    case 'AGENT_STATUS': {
      const agents = new Map(state.agents);
      const existing = agents.get(action.key);
      agents.set(action.key, {
        key: action.key,
        name: action.name ?? existing?.name ?? action.key,
        status: action.status,
        eventCount: existing?.eventCount ?? 0,
        startedAt: action.status === 'running' ? Date.now() : existing?.startedAt,
      });
      return { ...state, agents };
    }

    case 'AGENT_EVENT': {
      const agents = new Map(state.agents);
      const existing = agents.get(action.key);
      if (existing) {
        agents.set(action.key, { ...existing, eventCount: existing.eventCount + 1 });
      }
      return { ...state, agents };
    }

    case 'JUROR_STATUS': {
      const jurors = new Map(state.jurors);
      const existing = jurors.get(action.model);
      jurors.set(action.model, {
        model: action.model,
        status: action.status,
        chunkCount: existing?.chunkCount ?? 0,
      });
      return { ...state, jurors };
    }

    case 'JUROR_CHUNK': {
      const jurors = new Map(state.jurors);
      const existing = jurors.get(action.model);
      if (existing) {
        jurors.set(action.model, { ...existing, chunkCount: existing.chunkCount + 1 });
      }
      return { ...state, jurors };
    }

    case 'JUROR_COMPLETE': {
      const jurors = new Map(state.jurors);
      const existing = jurors.get(action.model);
      jurors.set(action.model, {
        model: action.model,
        status: action.success ? 'complete' : 'failed',
        chunkCount: existing?.chunkCount ?? 0,
      });
      return { ...state, jurors };
    }

    case 'SYNTHESIS_START':
      return state;

    case 'COMPLETE':
      return {
        ...state,
        record: action.record,
        rankings: action.record.metadata.aggregateRankings,
        done: true,
      };

    case 'ERROR':
      return { ...state, error: action.error, done: true };

    default:
      return state;
  }
}

export const initialState: DeliberationState = {
  stage: 0,
  stageSummary: '',
  agents: new Map(),
  jurors: new Map(),
  rankings: [],
  record: null,
  error: null,
  done: false,
};

export function useDeliberation(): [DeliberationState, EventHandler] {
  const [state, dispatch] = useReducer(deliberationReducer, initialState);

  const handlers: EventHandler = {
    onStageChange: (stage, summary) => dispatch({ type: 'STAGE_CHANGE', stage, summary }),
    onAgentStatus: (key, status, name) => dispatch({ type: 'AGENT_STATUS', key, status, name }),
    onAgentEvent: (key, event) => dispatch({ type: 'AGENT_EVENT', key, event }),
    onJurorStatus: (model, status) => dispatch({ type: 'JUROR_STATUS', model, status }),
    onJurorChunk: (model) => dispatch({ type: 'JUROR_CHUNK', model }),
    onJurorComplete: (model, success, usage) => dispatch({ type: 'JUROR_COMPLETE', model, success, usage }),
    onSynthesisStart: () => dispatch({ type: 'SYNTHESIS_START' }),
    onComplete: (record) => dispatch({ type: 'COMPLETE', record }),
    onError: (error) => dispatch({ type: 'ERROR', error }),
  };

  return [state, handlers];
}
