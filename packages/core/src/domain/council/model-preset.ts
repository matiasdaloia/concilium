export type ModelPreset = 'fast' | 'balanced' | 'thorough';

/**
 * Default models per preset. These are convenience aliases so users
 * don't need to look up OpenRouter model IDs.
 *
 * - fast: free/cheap models, good for quick feedback
 * - balanced: mid-tier models, good accuracy-to-cost ratio
 * - thorough: top-tier models, maximum depth and accuracy
 *
 * Users always pay their own OpenRouter costs directly.
 */
export const PRESET_MODELS: Record<ModelPreset, string[]> = {
  fast: [
    'google/gemini-2.5-flash',
    'deepseek/deepseek-chat-v3',
    'meta-llama/llama-4-maverick',
  ],
  balanced: [
    'anthropic/claude-sonnet-4.5',
    'openai/gpt-5.2',
    'google/gemini-3-pro-preview',
  ],
  thorough: [
    'anthropic/claude-opus-4.6',
    'openai/gpt-5.2',
    'google/gemini-3-pro-preview',
  ],
};

export function isValidPreset(value: string): value is ModelPreset {
  return value === 'fast' || value === 'balanced' || value === 'thorough';
}
