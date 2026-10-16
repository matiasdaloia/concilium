// Domain types
export type { AgentId, AgentProviderType, AgentInstance, AgentStatus, AgentConfig } from './domain/agent/agent-config.js';
export {
  PROVIDERS,
  PROVIDER_IDS,
  isProviderId,
  getProviderInfo,
} from './domain/agent/providers.js';
export type { ProviderInfo } from './domain/agent/providers.js';
export type { AgentResult } from './domain/agent/agent-result.js';
export type { EventType, TokenUsage, ParsedEvent } from './domain/agent/parsed-event.js';
export { RunController, runAgentsParallel, agentBrief, toParsedEvent, AGENT_TIMEOUT_MS } from './domain/agent/agent-executor.js';
export type { AgentModelInfo, RunnerCallbacks } from './domain/agent/agent-executor.js';

export type { CouncilConfig } from './domain/council/council-config.js';
export { OPENROUTER_API_URL } from './domain/council/council-config.js';
export { parseCouncilMember, memberFamily, resolveCouncil } from './domain/council/council-members.js';
export type { CouncilMember, ResolvedCouncil } from './domain/council/council-members.js';
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

export type { TaskType, Playbook, TaskTypeChoice } from './domain/code-council/playbooks.js';
export { TASK_TYPES, PLAYBOOKS, isTaskType, classifyTask } from './domain/code-council/playbooks.js';
export type { RubricCriterion, RubricEvidence, FrozenRubric } from './domain/code-council/rubric.js';
export {
  RUBRIC_EVIDENCE,
  MIN_CRITERIA,
  MAX_CRITERIA,
  RubricValidationError,
  parseRubricCriteria,
  parseRubricAnswer,
  rubricHash,
  freezeRubric,
  rubricPrompt,
} from './domain/code-council/rubric.js';

// Port interfaces
export type { LlmGateway, LlmResponse } from './ports/llm-gateway.js';
export type { RunRepository } from './ports/run-repository.js';
export type { ConfigStore, CouncilConfigPrefs } from './ports/config-store.js';
export type { SecretStore } from './ports/secret-store.js';
export type { DeliberationEvents } from './ports/deliberation-events.js';
export type { HeadlessCliDriver, CliDetection, CliAuth, DriverRunOptions } from './ports/headless-cli-driver.js';
export type { WorkspaceManager, Workspace, RunBase, GcOptions, GcRunResult, DiffStat, PatchCheck } from './ports/workspace.js';

// Adapters
export { OpenRouterGateway } from './adapters/openrouter-gateway.js';
export { JsonRunRepository } from './adapters/json-run-repository.js';
export { JsonConfigStore } from './adapters/json-config-store.js';
export { JsonCodeRunStore } from './adapters/json-code-run-store.js';
export { PlaintextSecretStore } from './adapters/plaintext-secret-store.js';
export {
  GitWorktreeWorkspace,
  DirtyWorktreeError,
  candidateBranch,
  integrationBranch,
  BRANCH_PREFIX,
  INTEGRATION_CANDIDATE,
} from './adapters/git-worktree-workspace.js';
export { streamSubprocess, captureSubprocess, detectRateLimit } from './adapters/cli/subprocess.js';
export type { SubprocessSpec, SubprocessItem, SubprocessOutcome, RateLimitSignal } from './adapters/cli/subprocess.js';
export { FakeCliDriver } from './adapters/cli/fake-cli-driver.js';
export { CliCouncilGateway, councilBrief, COUNCIL_PROMPT_FILE, COUNCIL_TIMEOUT_MS } from './adapters/cli/cli-council-gateway.js';
export { CliDriver, createHeadlessCliDrivers, parseOpenCodeModels } from './adapters/cli/cli-drivers.js';
export type { HeadlessCliId } from './adapters/cli/cli-drivers.js';
export type { FakeCliDriverOptions } from './adapters/cli/fake-cli-driver.js';

// Application services
export { DeliberationService } from './services/deliberation-service.js';
export type { DeliberationInput, DeliberationDeps } from './services/deliberation-service.js';
export { ConfigService } from './services/config-service.js';
export { ModelDiscoveryService } from './services/model-discovery-service.js';
export type { CodeFrame } from './domain/code-council/framing.js';
export { framedTask, missingPlaybookSteps } from './domain/code-council/framing.js';
export { runCodeCandidates, codeBrief, newRunId, CODE_TIMEOUT_MS, FRAME_TIMEOUT_MS } from './services/code-service.js';
export type { CodeAgent, CodeCandidate, CodeRunRecord, CodeRunInput, CodeRunStatus } from './services/code-service.js';
export type { Gate, GatePlan, GateResult, GateVerdict, InstallStep, StepResult } from './domain/verification/gates.js';
export { VERIFY_CONFIG, GATE_TIMEOUT_MS, INSTALL_TIMEOUT_MS, detectGates, parseVerifyConfig, planGates, judgeGates } from './domain/verification/gates.js';
export type { FileDiff, IntegrityFinding, IntegrityRule, ManifestChange } from './domain/verification/integrity.js';
export { checkIntegrity, parseDiff, isTestFile } from './domain/verification/integrity.js';
export type { AdversarialTest, AdversarialTestSpec, Survival, SurvivalCell, SurvivalMatrix, TestValidity } from './domain/verification/adversarial.js';
export { ADVERSARIAL_MANIFEST, MAX_TESTS_PER_ADVERSARY, adversaryBrief, classifyTest, parseAdversarialManifest, survival, testGate } from './domain/verification/adversarial.js';
export { GateRunner, type LaneResult } from './adapters/gate-runner.js';
export { runAdversarialRound, runTestInLane } from './services/adversarial-service.js';
export type { Adversary, AdversarialCandidate, AdversarialInput, AdversarialRound, AdversarialRun } from './services/adversarial-service.js';
export type { CandidateReport, DiffSize, EvidenceKey, RankEntry, RankInput, Ranking, ReportEvidence, WorkerStatus } from './domain/code-council/ranking.js';
export { compareEvidence, contends, rankCandidates, tieGroups } from './domain/code-council/ranking.js';
export type { JudgeChoice, JudgePack, JudgeScore, Judgment } from './domain/code-council/judging.js';
export { MAX_SCORE, JudgeValidationError, judgePrompt, parseJudgeAnswer, pickJudge } from './domain/code-council/judging.js';
export type { Graft, GraftEvidence, GraftIdea, GraftPack, Synthesis, SynthesisChecks } from './domain/code-council/synthesis.js';
export {
  MAX_GRAFTS_PER_CANDIDATE, RESULT_PATCH, SYNTHESIS_REPORT, graftPrompt, integratorBrief, parseGraftAnswer, synthesisMarkdown,
} from './domain/code-council/synthesis.js';
export { JUDGE_DIFF_LIMIT, judgeTie, rankRun, reportCandidate, usableClis } from './services/ranking-service.js';
export { skippedSynthesis, synthesize } from './services/synthesis-service.js';
export type { Conflict, Divergence, DivergenceCandidate, DivergenceTrigger, Reframe, ReframePack, SpecQuestion } from './domain/code-council/reframe.js';
export {
  REFRAME_REPORT, completeQuestions, detectDivergence, fallbackQuestion, parseReframeAnswer, reframeMarkdown, reframePrompt,
} from './domain/code-council/reframe.js';
export { reframeRun } from './services/reframe-service.js';
export type { ReframeInput } from './services/reframe-service.js';
export type { SynthesisInput } from './services/synthesis-service.js';
export type { JudgeTieInput, RankRunInput } from './services/ranking-service.js';
export { verifyCandidates, judgeCandidate, BASE_LANE } from './services/verification-service.js';
export type { CandidateVerification, RunVerification, VerifyInput } from './services/verification-service.js';
export type { CodeRoleMap, CodeRoleName, ResolvedRole, RoleMap, RoleName, RoleSettings, RoleSource, RoleValue } from './domain/roles/roles.js';
export {
  CODE_ROLES, FACTORY_CONFIG, ROLE_KEYWORDS, ROLE_NAMES, RolesValidationError, defaultCodeRoles, isListRole, parseFactoryRoles, parseRoleFlags,
  pickRole, resolveCodeRoles, roleWarnings, specAgent, specFamily, validateRoles,
} from './domain/roles/roles.js';
export { createConciliumRuntime, createDrivers, NO_AGENT_CLI_MESSAGE, TERMS_OF_USE_URL } from './services/create-concilium.js';
export type { ConciliumAdapters, ConciliumRuntime } from './services/create-concilium.js';

// Shared
export { createLogger, setLogLevel, getLogLevel } from './shared/logger.js';
export type { Logger, LogLevel } from './shared/logger.js';
