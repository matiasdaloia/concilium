import type { Command } from 'commander';
import {
  createDrivers,
  PROVIDER_IDS,
  ModelDiscoveryService,
  OpenRouterGateway,
  ConfigService,
  JsonConfigStore,
  PlaintextSecretStore,
} from '@concilium/core';
import { getConfigDir } from '../adapters/xdg-paths.js';

export function registerModelsCommand(program: Command): void {
  program
    .command('models')
    .description('List available models')
    .option('--agent <name>', `Models for a specific agent (${PROVIDER_IDS.join(', ')})`)
    .option('--council', 'OpenRouter models for jurors/chairman (needs an API key)')
    .option('--json', 'Output as JSON')
    .action(async (opts: { agent?: string; council?: boolean; json?: boolean }) => {
      if (opts.council) {
        const secretStore = new PlaintextSecretStore();
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

      const drivers = createDrivers();
      if (opts.agent) {
        for (const id of drivers.keys()) if (id !== opts.agent) drivers.delete(id);
      }
      const discovery = new ModelDiscoveryService(drivers);
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
