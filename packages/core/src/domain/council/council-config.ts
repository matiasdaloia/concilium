export interface CouncilConfig {
  /** Only needed for OpenRouter jurors or chairman. */
  openRouterApiKey: string;
  openRouterApiUrl: string;
  /** Juror member specs (see `parseCouncilMember`). Empty means chosen from the installed agent CLIs at run time. */
  councilModels: string[];
  /** Chairman member spec. Empty means chosen from the installed agent CLIs at run time. */
  chairmanModel: string;
}

export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
