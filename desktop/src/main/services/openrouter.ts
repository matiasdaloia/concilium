import type { CouncilConfig } from './types';
import { createLogger } from './logger';

const log = createLogger('openrouter');

export interface OpenRouterUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OpenRouterResponse {
  content: string;
  usage?: OpenRouterUsage;
}

export async function queryModel(
  config: CouncilConfig,
  model: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs = 120_000,
): Promise<OpenRouterResponse | null> {
  log.debug(`queryModel: starting request to ${model} (timeout: ${timeoutMs}ms)`);
  
  if (!config.openRouterApiKey) {
    log.error(`queryModel: OPENROUTER_API_KEY is missing!`);
    return null;
  }
  
  try {
    log.debug(`queryModel: fetching from ${config.openRouterApiUrl}`);
    const response = await fetch(config.openRouterApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'could not read response body');
      log.error(`queryModel: HTTP ${response.status} ${response.statusText} for ${model}`, errorText);
      return null;
    }

    log.debug(`queryModel: received response for ${model}, parsing JSON...`);
    const data = await response.json();
    const choices = data?.choices;
    
    // Extract usage data if present
    let usage: OpenRouterUsage | undefined;
    if (data?.usage) {
      const u = data.usage;
      usage = {
        promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0,
        completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
        totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : 0,
      };
    }
    
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0];
      const content = first?.message?.content;
      const contentLength = typeof content === 'string' ? content.length : 0;
      log.info(`queryModel: success for ${model}, content length: ${contentLength} chars`);
      return { content: typeof content === 'string' ? content : '', usage };
    }
    log.warn(`queryModel: no choices in response for ${model}`, JSON.stringify(data).slice(0, 500));
    return { content: '', usage };
  } catch (err) {
    log.error(`queryModel: exception for ${model}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function queryModelsParallel(
  config: CouncilConfig,
  models: string[],
  messages: Array<{ role: string; content: string }>,
  onModelComplete?: (model: string, success: boolean) => void,
  onModelStart?: (model: string) => void,
): Promise<Record<string, OpenRouterResponse | null>> {
  log.debug(`queryModelsParallel: starting parallel queries to ${models.length} models:`, models);
  
  const results = await Promise.allSettled(
    models.map(async (model) => {
      onModelStart?.(model);
      const result = await queryModel(config, model, messages);
      onModelComplete?.(model, result !== null);
      return [model, result] as const;
    }),
  );

  const output: Record<string, OpenRouterResponse | null> = {};
  let successCount = 0;
  let failCount = 0;
  
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const [model, response] = result.value;
      output[model] = response;
      if (response !== null) successCount++;
      else failCount++;
    } else {
      failCount++;
      log.error(`queryModelsParallel: promise rejected:`, result.reason);
    }
  }
  
  log.info(`queryModelsParallel: completed - ${successCount} success, ${failCount} failed`);
  return output;
}

const BATCH_INTERVAL_MS = 50;

// ============================================================================
// Model Discovery & Caching
// ============================================================================

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: number;
    completion: number;
  };
}

// Session cache for models
let cachedModels: OpenRouterModelInfo[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000 as number; // 1 hour

// Curated fallback list of popular OpenRouter models
const FALLBACK_MODELS: OpenRouterModelInfo[] = [
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    context_length: 128000,
    pricing: { prompt: 2.5, completion: 10 },
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    context_length: 128000,
    pricing: { prompt: 0.15, completion: 0.6 },
  },
  {
    id: "anthropic/claude-3.5-sonnet",
    name: "Claude 3.5 Sonnet",
    context_length: 200000,
    pricing: { prompt: 3, completion: 15 },
  },
  {
    id: "anthropic/claude-3.5-haiku",
    name: "Claude 3.5 Haiku",
    context_length: 200000,
    pricing: { prompt: 0.8, completion: 4 },
  },
  {
    id: "anthropic/claude-3-opus",
    name: "Claude 3 Opus",
    context_length: 200000,
    pricing: { prompt: 15, completion: 75 },
  },
  {
    id: "google/gemini-1.5-pro",
    name: "Gemini 1.5 Pro",
    context_length: 2000000,
    pricing: { prompt: 3.5, completion: 10.5 },
  },
  {
    id: "google/gemini-1.5-flash",
    name: "Gemini 1.5 Flash",
    context_length: 1000000,
    pricing: { prompt: 0.35, completion: 0.53 },
  },
  {
    id: "meta-llama/llama-3.1-405b-instruct",
    name: "Llama 3.1 405B",
    context_length: 131072,
    pricing: { prompt: 2.7, completion: 2.7 },
  },
  {
    id: "meta-llama/llama-3.1-70b-instruct",
    name: "Llama 3.1 70B",
    context_length: 131072,
    pricing: { prompt: 0.52, completion: 0.75 },
  },
  {
    id: "mistralai/mistral-large",
    name: "Mistral Large",
    context_length: 128000,
    pricing: { prompt: 3, completion: 9 },
  },
  {
    id: "mistralai/mistral-medium",
    name: "Mistral Medium",
    context_length: 128000,
    pricing: { prompt: 2.7, completion: 8.1 },
  },
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V2.5",
    context_length: 64000,
    pricing: { prompt: 0.14, completion: 0.28 },
  },
  {
    id: "qwen/qwen-2.5-72b-instruct",
    name: "Qwen 2.5 72B",
    context_length: 128000,
    pricing: { prompt: 0.35, completion: 0.35 },
  },
  {
    id: "x-ai/grok-beta",
    name: "Grok Beta",
    context_length: 128000,
    pricing: { prompt: 5, completion: 15 },
  },
  {
    id: "cohere/command-r-plus",
    name: "Command R+",
    context_length: 128000,
    pricing: { prompt: 3, completion: 15 },
  },
  {
    id: "perplexity/llama-3.1-sonar-large-128k-online",
    name: "Perplexity Sonar Large",
    context_length: 127072,
    pricing: { prompt: 1, completion: 1 },
  },
  {
    id: "nvidia/llama-3.1-nemotron-70b-instruct",
    name: "Nemotron 70B",
    context_length: 131072,
    pricing: { prompt: 0.15, completion: 0.3 },
  },
  {
    id: "microsoft/phi-4",
    name: "Phi 4",
    context_length: 16000,
    pricing: { prompt: 0.07, completion: 0.14 },
  },
  {
    id: "amazon/nova-pro",
    name: "Nova Pro",
    context_length: 300000,
    pricing: { prompt: 0.8, completion: 3.2 },
  },
  {
    id: "amazon/nova-lite",
    name: "Nova Lite",
    context_length: 300000,
    pricing: { prompt: 0.06, completion: 0.24 },
  },
];

/**
 * Fetch available models from OpenRouter API
 */
export async function fetchOpenRouterModels(
  apiKey: string
): Promise<OpenRouterModelInfo[]> {
  // Return cached models if still valid
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://concilium.app",
        "X-Title": "Concilium",
      },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = (await response.json()) as { data: Array<Record<string, unknown>> };

    // Transform and sort models by name
    const models: OpenRouterModelInfo[] = data.data
      .map((m) => {
        const pricing = (m.pricing as { prompt?: number; completion?: number } | undefined) || {};
        // OpenRouter returns pricing per token. Convert to per 1M tokens for display.
        // If pricing is string, parsing it is handled by Number()
        const promptPrice = Number(pricing.prompt) || 0;
        const completionPrice = Number(pricing.completion) || 0;
        
        return {
          id: String(m.id || ""),
          name: String(m.name || m.id || ""),
          description: m.description ? String(m.description) : undefined,
          context_length: Number(m.context_length) || 4096,
          pricing: {
            prompt: promptPrice * 1000000,
            completion: completionPrice * 1000000,
          },
        };
      })
      .filter((m) => m.id && m.name) // Filter out invalid entries
      .sort((a, b) => a.name.localeCompare(b.name));

    // Update cache
    cachedModels = models;
    cacheTimestamp = now;

    return models;
  } catch (error) {
    log.warn("Failed to fetch OpenRouter models, using fallback:", error);
    return FALLBACK_MODELS;
  }
}

/**
 * Get cached models or fallback list if no cache exists
 */
export function getCachedOrFallbackModels(): OpenRouterModelInfo[] {
  const now = Date.now();
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }
  return FALLBACK_MODELS;
}

/**
 * Clear the model cache (useful for testing or manual refresh)
 */
export function clearModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}

/**
 * Format pricing for display (per 1M tokens)
 */
export function formatPricing(prompt: number, completion: number): string {
  const format = (n: number) => {
    if (n === 0) return "Free";
    if (n < 0.01) return `$${(n * 1000).toFixed(1)}µ`;
    if (n < 1) return `$${(n * 100).toFixed(0)}¢`;
    return `$${n.toFixed(2)}`;
  };
  return `${format(prompt)} / ${format(completion)}`;
}

/**
 * Get provider from model ID (e.g., "openai/gpt-4o" -> "OpenAI")
 */
export function getProviderFromId(modelId: string): string {
  const provider = modelId.split("/")[0];
  const providerMap: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    "meta-llama": "Meta",
    mistralai: "Mistral",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    "x-ai": "xAI",
    cohere: "Cohere",
    perplexity: "Perplexity",
    nvidia: "NVIDIA",
    microsoft: "Microsoft",
    amazon: "Amazon",
  };
  return providerMap[provider] || provider;
}

export async function queryModelStreaming(
  config: CouncilConfig,
  model: string,
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  timeoutMs = 120_000,
): Promise<OpenRouterResponse | null> {
  log.debug(`queryModelStreaming: starting streaming request to ${model} (timeout: ${timeoutMs}ms)`);
  
  if (!config.openRouterApiKey) {
    log.error(`queryModelStreaming: OPENROUTER_API_KEY is missing!`);
    return null;
  }
  
  try {
    log.debug(`queryModelStreaming: fetching from ${config.openRouterApiUrl}`);
    const response = await fetch(config.openRouterApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        'Content-Type': 'application/json',
      },
      // Request usage data in streaming response
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'could not read response body');
      log.error(`queryModelStreaming: HTTP ${response.status} ${response.statusText} for ${model}`, errorText);
      return null;
    }
    
    if (!response.body) {
      log.error(`queryModelStreaming: no response body for ${model}`);
      return null;
    }
    
    log.debug(`queryModelStreaming: stream opened for ${model}, reading chunks...`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let lineBuffer = '';
    let batchBuffer = '';
    let batchTimer: ReturnType<typeof setTimeout> | null = null;
    let usage: OpenRouterUsage | undefined;

    const flushBatch = () => {
      if (batchBuffer) {
        onChunk(batchBuffer);
        batchBuffer = '';
      }
      batchTimer = null;
    };

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') return;
      if (!trimmed.startsWith('data: ')) return;

      try {
        const json = JSON.parse(trimmed.slice(6));
        
        // Check for usage data (sent in final chunk with stream_options.include_usage)
        if (json?.usage) {
          const u = json.usage;
          usage = {
            promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0,
            completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
            totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : 0,
          };
        }
        
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          accumulated += delta;
          batchBuffer += delta;
          if (!batchTimer) {
            batchTimer = setTimeout(flushBatch, BATCH_INTERVAL_MS);
          }
        }
      } catch {
        // skip malformed JSON lines
      }
    };

    try {
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        streamDone = done;
        if (!value) continue;

        lineBuffer += decoder.decode(value, { stream: !done });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      }

      if (lineBuffer) {
        processLine(lineBuffer);
      }
    } finally {
      if (batchTimer) clearTimeout(batchTimer);
      if (batchBuffer) onChunk(batchBuffer);
    }

    log.info(`queryModelStreaming: completed for ${model}, total length: ${accumulated.length} chars`);
    return { content: accumulated, usage };
  } catch (err) {
    log.error(`queryModelStreaming: exception for ${model}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function queryModelsParallelStreaming(
  config: CouncilConfig,
  models: string[],
  messages: Array<{ role: string; content: string }>,
  onModelStart?: (model: string) => void,
  onModelChunk?: (model: string, chunk: string) => void,
  onModelComplete?: (model: string, success: boolean, usage?: OpenRouterUsage) => void,
): Promise<Record<string, OpenRouterResponse | null>> {
  log.debug(`queryModelsParallelStreaming: starting parallel streaming to ${models.length} models:`, models);
  
  const results = await Promise.allSettled(
    models.map(async (model) => {
      onModelStart?.(model);
      const result = await queryModelStreaming(
        config,
        model,
        messages,
        (chunk) => onModelChunk?.(model, chunk),
      );
      onModelComplete?.(model, result !== null, result?.usage);
      return [model, result] as const;
    }),
  );

  const output: Record<string, OpenRouterResponse | null> = {};
  let successCount = 0;
  let failCount = 0;
  
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const [model, response] = result.value;
      output[model] = response;
      if (response !== null) successCount++;
      else failCount++;
    } else {
      failCount++;
      log.error(`queryModelsParallelStreaming: promise rejected:`, result.reason);
    }
  }
  
  log.info(`queryModelsParallelStreaming: completed - ${successCount} success, ${failCount} failed`);
  return output;
}
