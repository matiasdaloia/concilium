// Domain types
export type { AgentId, BuiltinAgentId, McpAgentId, BuiltinProviderType, AgentProviderType, AgentInstance, AgentStatus, AgentConfig } from './domain/agent/agent-config.js';
export type { AgentResult } from './domain/agent/agent-result.js';
export type { EventType, TokenUsage, ParsedEvent } from './domain/agent/parsed-event.js';
export { RunController, runAgentsParallel, DEFAULT_AGENT_MODELS } from './domain/agent/agent-executor.js';
export type { AgentModelInfo } from './domain/agent/agent-executor.js';

export type { CouncilConfig } from './domain/council/council-config.js';
export { DEFAULT_COUNCIL_MODELS, DEFAULT_CHAIRMAN_MODEL, OPENROUTER_API_URL } from './domain/council/council-config.js';
export type { Stage1Result, Stage2Result, Stage3Result, CouncilTokenUsage } from './domain/council/stage-results.js';
export type { OpenRouterModelInfo } from './domain/council/model-info.js';
export { formatPricing, getProviderFromId } from './domain/council/model-info.js';
export type { ModelPreset } from './domain/council/model-preset.js';
export { PRESET_MODELS, isValidPreset } from './domain/council/model-preset.js';

export type { ImageAttachment, StartRunConfig } from './domain/deliberation/deliberation.js';
export { wrapPromptForResearch, buildVerifyPrompt } from './domain/deliberation/prompts.js';
export type { VerifyPromptOptions } from './domain/deliberation/prompts.js';
export { runCouncilStages } from './domain/deliberation/pipeline.js';
export type { CouncilProgressCallbacks } from './domain/deliberation/pipeline.js';
export { calculateConfidence } from './domain/deliberation/confidence.js';
export type { ConfidenceScore, Disagreement } from './domain/deliberation/confidence.js';
export { buildVerifyReport } from './domain/deliberation/verify-report.js';
export type { VerifyReport, Stage2Summary } from './domain/deliberation/verify-report.js';

export type { RunRecord, RunMode } from './domain/run/run-record.js';
export type { RunMetadata, AggregateRanking, UserRanking, ModelPerformanceSnapshot } from './domain/run/run-metadata.js';

// Port interfaces
export type { AgentProvider, AgentExecutionConfig } from './ports/agent-provider.js';
export type { LlmGateway, LlmResponse } from './ports/llm-gateway.js';
export type { RunRepository } from './ports/run-repository.js';
export type { ConfigStore, CouncilConfigPrefs } from './ports/config-store.js';
export type { SecretStore } from './ports/secret-store.js';
export type { DeliberationEvents } from './ports/deliberation-events.js';
export type { GithubGateway, PrDiff, PrFile } from './ports/github-gateway.js';

// Adapters
export { OpenRouterGateway } from './adapters/openrouter-gateway.js';
export { ClaudeProvider } from './adapters/claude-provider.js';
export { CodexProvider } from './adapters/codex-provider.js';
export { OpenCodeProvider, ensureOpenCodeServer, shutdownEmbeddedServer } from './adapters/opencode-provider.js';
export type { OpenCodeServerHandle, OpenCodeSdkConfig } from './adapters/opencode-provider.js';
export { JsonRunRepository } from './adapters/json-run-repository.js';
export { JsonConfigStore } from './adapters/json-config-store.js';
export { PlaintextSecretStore } from './adapters/plaintext-secret-store.js';
export { GitHubRestGateway, parsePrUrl } from './adapters/github-rest-gateway.js';
export { McpAgentProvider } from './adapters/mcp-provider.js';
export type { McpProviderConfig } from './adapters/mcp-provider.js';

// Application services
export { DeliberationService } from './services/deliberation-service.js';
export type { DeliberationInput, DeliberationDeps } from './services/deliberation-service.js';
export { ConfigService } from './services/config-service.js';
export { ModelDiscoveryService } from './services/model-discovery-service.js';
export { discoverContext, formatDiscoveredContext } from './services/context-discovery.js';
export type { DiscoveredContext, DiscoveredConvention, McpServerConfig } from './services/context-discovery.js';

// Shared
export { createLogger, setLogLevel, getLogLevel } from './shared/logger.js';
export type { Logger, LogLevel } from './shared/logger.js';
export { ConciliumError, ConfigError, PipelineError, AgentError } from './shared/errors.js';
