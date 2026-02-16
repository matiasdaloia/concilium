import type { CouncilTokenUsage } from '../domain/council/stage-results.js';
import type { OpenRouterModelInfo } from '../domain/council/model-info.js';

export interface LlmResponse {
  content: string;
  usage?: CouncilTokenUsage;
}

export interface LlmGateway {
  query(
    model: string,
    messages: Array<{ role: string; content: string }>,
    timeoutMs?: number,
  ): Promise<LlmResponse | null>;

  queryStreaming(
    model: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: (text: string) => void,
    timeoutMs?: number,
  ): Promise<LlmResponse | null>;

  queryModelsParallelStreaming(
    models: string[],
    messages: Array<{ role: string; content: string }>,
    onModelStart?: (model: string) => void,
    onModelChunk?: (model: string, chunk: string) => void,
    onModelComplete?: (model: string, success: boolean, usage?: CouncilTokenUsage) => void,
  ): Promise<Record<string, LlmResponse | null>>;

  fetchModels(): Promise<OpenRouterModelInfo[]>;
  getCachedOrFallbackModels(): OpenRouterModelInfo[];
  clearModelCache(): void;
}
