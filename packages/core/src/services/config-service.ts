import type { CouncilConfig } from '../domain/council/council-config.js';
import { OPENROUTER_API_URL } from '../domain/council/council-config.js';
import type { ConfigStore } from '../ports/config-store.js';
import type { SecretStore } from '../ports/secret-store.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('config-service');

export class ConfigService {
  constructor(
    private configStore: ConfigStore,
    private secretStore: SecretStore,
  ) {}

  /**
   * Per setting, highest first: `overrides` (CLI flags, `deliberate()` options), env var, saved config, default.
   * Jurors and chairman default to empty, which the runtime fills in from the installed agent CLIs.
   */
  async resolve(overrides: Partial<CouncilConfig> = {}): Promise<CouncilConfig> {
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

    const envCouncil = envCouncilModels.split(',').map((s) => s.trim()).filter(Boolean);
    const councilModels = envCouncil.length > 0 ? envCouncil : prefCouncilModels;

    const chairmanModel = envChairmanModel || prefs.chairmanModel || '';

    return {
      openRouterApiKey: apiKey,
      openRouterApiUrl: apiUrl,
      councilModels,
      chairmanModel,
      ...overrides,
    };
  }

  async saveApiKey(key: string): Promise<void> {
    await this.saveCouncilConfig({ apiKey: key });
  }

  /** Merge the given settings into the saved config; settings not given keep their saved value. */
  async saveCouncilConfig(prefs: { chairmanModel?: string; councilModels?: string[]; apiKey?: string }): Promise<void> {
    const config = await this.configStore.getCouncilConfigPrefs();
    if (prefs.chairmanModel) config.chairmanModel = prefs.chairmanModel;
    if (prefs.councilModels) config.councilModels = prefs.councilModels;
    if (prefs.apiKey) config.apiKeyEncrypted = this.secretStore.encrypt(prefs.apiKey);
    await this.configStore.saveCouncilConfigPrefs(config);
  }
}
