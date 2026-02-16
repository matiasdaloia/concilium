import type { AgentId } from '../agent/agent-config.js';
import type { AgentResult } from '../agent/agent-result.js';
import type { Stage1Result, Stage2Result, Stage3Result } from '../council/stage-results.js';
import type { RunMetadata } from './run-metadata.js';

export interface RunRecord {
  id: string;
  createdAt: string;
  prompt: string;
  cwd: string;
  selectedAgents: AgentId[];
  agents: AgentResult[];
  stage1: Stage1Result[];
  stage2: Stage2Result[];
  stage3?: Stage3Result | null;
  metadata: RunMetadata;
}
