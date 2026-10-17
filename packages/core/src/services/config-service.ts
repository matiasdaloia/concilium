import type { CouncilConfig } from '../domain/council/council-config.js';
import { OPENROUTER_API_URL } from '../domain/council/council-config.js';
import { roleOrigin } from '../domain/roles/role-rules.js';
import { validateRoles, type RoleSettings, type RoleSource } from '../domain/roles/roles.js';
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
   * Per setting, highest first: `overrides` (CLI flags, `deliberate()` options), env var, the repo's `factory.yaml`
   * (`repo`, its `juror` and `chairman` roles), saved config, default.
   * Jurors and chairman default to empty, which the runtime fills in from the installed agent CLIs.
   */
  async resolve(overrides: Partial<CouncilConfig> = {}, repo: RoleSettings = {}): Promise<CouncilConfig> {
    return (await this.resolveWithSources(overrides, repo)).config;
  }

  /** `resolve`, plus where the jurors and the chairman came from. */
  async resolveWithSources(
    overrides: Partial<CouncilConfig> = {},
    repo: RoleSettings = {},
  ): Promise<{ config: CouncilConfig; sources: { councilModels: RoleSource; chairmanModel: RoleSource } }> {
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
    const repoJurors = Array.isArray(repo.juror) ? repo.juror : [];
    const repoChairman = typeof repo.chairman === 'string' ? repo.chairman : '';
    const [councilModels, jurorSource]: [string[], RoleSource] = overrides.councilModels !== undefined ? [overrides.councilModels, 'flag']
      : envCouncil.length > 0 ? [envCouncil, 'env']
      : repoJurors.length > 0 ? [repoJurors, 'repo']
      : prefCouncilModels.length > 0 ? [prefCouncilModels, 'saved']
      : [[], 'default'];
    const [chairmanModel, chairmanSource]: [string, RoleSource] = overrides.chairmanModel !== undefined ? [overrides.chairmanModel, 'flag']
      : envChairmanModel ? [envChairmanModel, 'env']
      : repoChairman ? [repoChairman, 'repo']
      : prefs.chairmanModel ? [prefs.chairmanModel, 'saved']
      : ['', 'default'];

    return {
      config: {
        openRouterApiKey: apiKey,
        openRouterApiUrl: apiUrl,
        ...overrides,
        councilModels,
        chairmanModel,
      },
      sources: { councilModels: jurorSource, chairmanModel: chairmanSource },
    };
  }

  /** The saved code-council roles. */
  async savedRoles(): Promise<RoleSettings> {
    return validateRoles((await this.configStore.getCouncilConfigPrefs()).roles, roleOrigin.file('saved', 'saved config'));
  }

  /** Merge `roles` into the saved roles; roles not given keep their saved value. */
  async saveRoles(roles: RoleSettings): Promise<void> {
    const config = await this.configStore.getCouncilConfigPrefs();
    config.roles = { ...config.roles, ...roles };
    await this.configStore.saveCouncilConfigPrefs(config);
  }

  /** The saved same-family verifier opt-in, or undefined when none is saved. */
  async savedAllowSameFamilyVerifier(): Promise<boolean | undefined> {
    const value = (await this.configStore.getCouncilConfigPrefs()).allowSameFamilyVerifier;
    return typeof value === 'boolean' ? value : undefined;
  }

  async saveAllowSameFamilyVerifier(allow: boolean): Promise<void> {
    const config = await this.configStore.getCouncilConfigPrefs();
    config.allowSameFamilyVerifier = allow;
    await this.configStore.saveCouncilConfigPrefs(config);
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
