export class ConciliumError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'ConciliumError';
  }
}

export class ConfigError extends ConciliumError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class PipelineError extends ConciliumError {
  constructor(message: string) {
    super(message, 'PIPELINE_ERROR');
    this.name = 'PipelineError';
  }
}

export class AgentError extends ConciliumError {
  constructor(message: string, public readonly agentId?: string) {
    super(message, 'AGENT_ERROR');
    this.name = 'AgentError';
  }
}
