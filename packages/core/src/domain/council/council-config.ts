export interface CouncilConfig {
  openRouterApiKey: string;
  openRouterApiUrl: string;
  councilModels: string[];
  chairmanModel: string;
}

export interface CommandSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export const DEFAULT_COUNCIL_MODELS = [
  'openai/gpt-5.2',
  'google/gemini-3-pro-preview',
  'anthropic/claude-opus-4.6',
];

export const DEFAULT_CHAIRMAN_MODEL = 'google/gemini-3-pro-preview';
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
