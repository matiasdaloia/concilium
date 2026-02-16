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

export function formatPricing(prompt: number, completion: number): string {
  const format = (n: number) => {
    if (n === 0) return 'Free';
    if (n < 0.01) return `$${(n * 1000).toFixed(1)}\u00B5`;
    if (n < 1) return `$${(n * 100).toFixed(0)}\u00A2`;
    return `$${n.toFixed(2)}`;
  };
  return `${format(prompt)} / ${format(completion)}`;
}

export function getProviderFromId(modelId: string): string {
  const provider = modelId.split('/')[0];
  const providerMap: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    'meta-llama': 'Meta',
    mistralai: 'Mistral',
    deepseek: 'DeepSeek',
    qwen: 'Qwen',
    'x-ai': 'xAI',
    cohere: 'Cohere',
    perplexity: 'Perplexity',
    nvidia: 'NVIDIA',
    microsoft: 'Microsoft',
    amazon: 'Amazon',
  };
  return providerMap[provider] || provider;
}
