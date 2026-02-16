import type { Command } from 'commander';
import {
  ClaudeProvider,
  CodexProvider,
  OpenCodeProvider,
  ModelDiscoveryService,
  OpenRouterGateway,
  ConfigService,
  JsonConfigStore,
  type AgentProvider,
} from '@concilium/core';
import { TerminalSecretStore } from '../adapters/terminal-secret-store.js';
import { getConfigDir } from '../adapters/xdg-paths.js';

export function registerModelsCommand(program: Command): void {
  program
    .command('models')
    .description('List available models')
    .option('--agent <name>', 'Models for a specific agent (claude, codex, opencode)')
    .option('--council', 'OpenRouter models for jurors/chairman')
    .option('--json', 'Output as JSON')
    .action(async (opts: { agent?: string; council?: boolean; json?: boolean }) => {
      if (opts.council) {
        const secretStore = new TerminalSecretStore();
        const configStore = new JsonConfigStore(getConfigDir());
        const configService = new ConfigService(configStore, secretStore);
        const config = await configService.resolve();

        if (!config.openRouterApiKey) {
          console.error('OpenRouter API key not configured. Run: concilium config set api-key');
          process.exit(1);
        }

        const gateway = new OpenRouterGateway(config.openRouterApiKey, config.openRouterApiUrl);
        const models = await gateway.fetchModels();

        if (opts.json) {
          console.log(JSON.stringify(models, null, 2));
        } else {
          console.log(`\n  OpenRouter Models (${models.length}):\n`);
          for (const m of models.slice(0, 50)) {
            console.log(`  ${m.id.padEnd(45)} ${m.name}`);
          }
          if (models.length > 50) {
            console.log(`  ... and ${models.length - 50} more (use --json for full list)`);
          }
          console.log();
        }
        return;
      }

      const providers = new Map<string, AgentProvider>();
      if (!opts.agent || opts.agent === 'claude') providers.set('claude', new ClaudeProvider());
      if (!opts.agent || opts.agent === 'codex') providers.set('codex', new CodexProvider());
      if (!opts.agent || opts.agent === 'opencode') providers.set('opencode', new OpenCodeProvider());

      const discovery = new ModelDiscoveryService(providers);
      const results = await discovery.discoverAll();

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const agent of results) {
          console.log(`\n  ${agent.id} (default: ${agent.defaultModel || 'auto'}):`);
          if (agent.models.length === 0) {
            console.log('    (no models discovered)');
          } else {
            for (const model of agent.models) {
              const isDefault = model === agent.defaultModel ? ' (default)' : '';
              console.log(`    ${model}${isDefault}`);
            }
          }
        }
        console.log();
      }
    });
}
