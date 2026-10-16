// Domain types
export type { AgentId, AgentProviderType, AgentInstance, AgentStatus, AgentConfig } from './domain/agent/agent-config.js';
export {
  PROVIDERS,
  PROVIDER_IDS,
  DEFAULT_PROVIDER,
  isProviderId,
  getProviderInfo,
  createDefaultAgentInstances,
} from './domain/agent/providers.js';
export type { ProviderInfo } from './domain/agent/providers.js';
export type { AgentResult } from './domain/agent/agent-result.js';
export type { EventType, TokenUsage, ParsedEvent } from './domain/agent/parsed-event.js';
export { RunController, runAgentsParallel, DEFAULT_AGENT_MODELS } from './domain/agent/agent-executor.js';
export type { AgentModelInfo } from './domain/agent/agent-executor.js';

export type { CouncilConfig } from './domain/council/council-config.js';
export { DEFAULT_COUNCIL_MODELS, DEFAULT_CHAIRMAN_MODEL, OPENROUTER_API_URL } from './domain/council/council-config.js';
export type { Stage1Result, Stage2Result, Stage3Result, CouncilTokenUsage } from './domain/council/stage-results.js';
export type { OpenRouterModelInfo } from './domain/council/model-info.js';
export { formatPricing, getProviderFromId } from './domain/council/model-info.js';

export type { ImageAttachment, StartRunConfig } from './domain/deliberation/deliberation.js';
export { wrapPromptForResearch } from './domain/deliberation/prompts.js';
export { runCouncilStages } from './domain/deliberation/pipeline.js';
export type { CouncilProgressCallbacks } from './domain/deliberation/pipeline.js';

export type { RunRecord } from './domain/run/run-record.js';
export type { RunMetadata, AggregateRanking, UserRanking, ModelPerformanceSnapshot } from './domain/run/run-metadata.js';

export type { Brief, BriefMode, AllowedAction } from './domain/driver/brief.js';
export { parseBrief, BriefValidationError, BRIEF_MODES, ALLOWED_ACTIONS } from './domain/driver/brief.js';
export type { Report, ReportStatus, EventCounts } from './domain/driver/report.js';
export { buildReport, parseReport, ReportValidationError, REPORT_STATUSES } from './domain/driver/report.js';
export type { NormalizedEvent, RunEvent, DriverUsage } from './domain/driver/normalized-event.js';

// Port interfaces
export type { AgentProvider, AgentExecutionConfig } from './ports/agent-provider.js';
export type { LlmGateway, LlmResponse } from './ports/llm-gateway.js';
export type { RunRepository } from './ports/run-repository.js';
export type { ConfigStore, CouncilConfigPrefs } from './ports/config-store.js';
export type { SecretStore } from './ports/secret-store.js';
export type { DeliberationEvents } from './ports/deliberation-events.js';
export type { HeadlessCliDriver, CliDetection, CliAuth, DriverRunOptions } from './ports/headless-cli-driver.js';

// Adapters
export { OpenRouterGateway } from './adapters/openrouter-gateway.js';
export { ClaudeProvider } from './adapters/claude-provider.js';
export { CodexProvider } from './adapters/codex-provider.js';
export { OpenCodeProvider, ensureOpenCodeServer, shutdownEmbeddedServer } from './adapters/opencode-provider.js';
export type { OpenCodeServerHandle, OpenCodeSdkConfig } from './adapters/opencode-provider.js';
export { JsonRunRepository } from './adapters/json-run-repository.js';
export { JsonConfigStore } from './adapters/json-config-store.js';
export { PlaintextSecretStore } from './adapters/plaintext-secret-store.js';
export { streamSubprocess, captureSubprocess, detectRateLimit } from './adapters/cli/subprocess.js';
export type { SubprocessSpec, SubprocessItem, SubprocessOutcome, RateLimitSignal } from './adapters/cli/subprocess.js';
export { FakeCliDriver } from './adapters/cli/fake-cli-driver.js';
export { CliDriver, createHeadlessCliDrivers, HEADLESS_CLI_IDS } from './adapters/cli/cli-drivers.js';
export type { HeadlessCliId } from './adapters/cli/cli-drivers.js';
export type { FakeCliDriverOptions } from './adapters/cli/fake-cli-driver.js';

// Application services
export { DeliberationService } from './services/deliberation-service.js';
export type { DeliberationInput, DeliberationDeps } from './services/deliberation-service.js';
export { ConfigService } from './services/config-service.js';
export { ModelDiscoveryService } from './services/model-discovery-service.js';
export { createConciliumRuntime, createProviders } from './services/create-concilium.js';
export type { ConciliumAdapters, ConciliumRuntime } from './services/create-concilium.js';

// Shared
export { createLogger, setLogLevel, getLogLevel } from './shared/logger.js';
export type { Logger, LogLevel } from './shared/logger.js';
