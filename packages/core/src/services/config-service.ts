import type { CouncilConfig } from '../domain/council/council-config.js';
import {
  DEFAULT_COUNCIL_MODELS,
  DEFAULT_CHAIRMAN_MODEL,
  OPENROUTER_API_URL,
} from '../domain/council/council-config.js';
import type { ConfigStore } from '../ports/config-store.js';
import type { SecretStore } from '../ports/secret-store.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('config-service');

export class ConfigService {
  constructor(
    private configStore: ConfigStore,
    private secretStore: SecretStore,
  ) {}

  async resolve(): Promise<CouncilConfig> {
    // Check environment variables first
    const envApiKey = process.env.OPENROUTER_API_KEY ?? '';
    const envCouncilModels = process.env.COUNCIL_MODELS ?? '';
    const envChairmanModel = process.env.CHAIRMAN_MODEL ?? '';
    const envApiUrl = process.env.OPENROUTER_API_URL ?? '';

    // Get user preferences
    const prefs = await this.configStore.getCouncilConfigPrefs();

    // Decrypt API key from preferences if exists and no env var
    let prefApiKey = '';
    if (prefs.apiKeyEncrypted && !envApiKey) {
      try {
        prefApiKey = this.secretStore.decrypt(prefs.apiKeyEncrypted);
      } catch {
        prefApiKey = '';
      }
    }

    // Parse council models from preferences
    const prefCouncilModels = prefs.councilModels ?? [];

    // Determine final values (env takes precedence)
    const apiKey = envApiKey || prefApiKey;
    const apiUrl = envApiUrl || OPENROUTER_API_URL;

    let councilModels: string[];
    if (envCouncilModels) {
      councilModels = envCouncilModels.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (prefCouncilModels.length > 0) {
      councilModels = prefCouncilModels;
    } else {
      councilModels = DEFAULT_COUNCIL_MODELS;
    }

    const chairmanModel = envChairmanModel || prefs.chairmanModel || DEFAULT_CHAIRMAN_MODEL;

    return {
      openRouterApiKey: apiKey,
      openRouterApiUrl: apiUrl,
      councilModels: councilModels.length > 0 ? councilModels : DEFAULT_COUNCIL_MODELS,
      chairmanModel,
    };
  }

  async saveApiKey(key: string): Promise<void> {
    const encrypted = this.secretStore.encrypt(key);
    await this.configStore.saveCouncilConfigPrefs({ apiKeyEncrypted: encrypted });
  }

  async saveCouncilConfig(prefs: { chairmanModel?: string; councilModels?: string[]; apiKey?: string }): Promise<void> {
    const config: { chairmanModel?: string; councilModels?: string[]; apiKeyEncrypted?: string } = {};
    if (prefs.chairmanModel) config.chairmanModel = prefs.chairmanModel;
    if (prefs.councilModels) config.councilModels = prefs.councilModels;
    if (prefs.apiKey) config.apiKeyEncrypted = this.secretStore.encrypt(prefs.apiKey);
    await this.configStore.saveCouncilConfigPrefs(config);
  }
}
