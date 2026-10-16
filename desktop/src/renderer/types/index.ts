// Domain types come from core. Type-only, so nothing from core is bundled into the renderer.
export type {
  AgentId,
  AgentProviderType as AgentProvider,
  AgentInstance,
  AgentStatus,
  EventType,
  TokenUsage,
  ParsedEvent,
  AgentResult,
  Stage1Result,
  CouncilTokenUsage,
  Stage2Result,
  Stage3Result,
  AggregateRanking,
  UserRanking,
  ModelPerformanceSnapshot,
  RunMetadata,
  RunRecord,
  OpenRouterModelInfo,
  AgentModelInfo,
  ImageAttachment,
} from '@concilium/core';
export type { CouncilConfig } from '../../preload/preload';
