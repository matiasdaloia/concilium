import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { CODE_ROLES, ConfigService, isListRole, JsonConfigStore, parseRoleFlags, PlaintextSecretStore, roleOrigin, SHIP_ROLES, type RoleName } from '@concilium/core';
import { getConfigDir } from '../adapters/xdg-paths.js';
import { printError } from '../formatters/roles.js';

/** The roles `config set` saves: the code council's and shipping's. */
const SAVED_ROLES: readonly RoleName[] = [...CODE_ROLES, ...SHIP_ROLES];

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Manage configuration');

  config
    .command('show')
    .description('Show current configuration')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const secretStore = new PlaintextSecretStore();
      const configStore = new JsonConfigStore(getConfigDir());
      const configService = new ConfigService(configStore, secretStore);
      const resolved = await configService.resolve();

      const display = {
        openRouterApiKey: resolved.openRouterApiKey ? '***' + resolved.openRouterApiKey.slice(-4) : '(not set)',
        openRouterApiUrl: resolved.openRouterApiUrl,
        councilModels: resolved.councilModels,
        chairmanModel: resolved.chairmanModel,
        roles: await configService.savedRoles(),
        configDir: getConfigDir(),
      };
      const savedRoles = Object.entries(display.roles).map(([role, v]) => `${role}=${Array.isArray(v) ? v.join(',') : v}`);
      const AUTO = 'auto (chosen from the installed agent CLIs at run time)';

      if (opts.json) {
        console.log(JSON.stringify(display, null, 2));
      } else {
        console.log(`\n  Configuration:`);
        console.log(`  API Key:        ${display.openRouterApiKey}${resolved.openRouterApiKey ? '' : ' (optional, only for OpenRouter jurors)'}`);
        console.log(`  API URL:        ${display.openRouterApiUrl}`);
        console.log(`  Juror Models:   ${display.councilModels.join(', ') || AUTO}`);
        console.log(`  Chairman:       ${display.chairmanModel || AUTO}`);
        console.log(`  Code roles:     ${savedRoles.join(' ') || '(none saved; see concilium roles)'}`);
        console.log(`  Config Dir:     ${display.configDir}`);
        console.log();
      }
    });

  config
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', `Configuration key (api-key, chairman, jurors, or a role: ${SAVED_ROLES.join(', ')})`)
    .argument('[value]', 'Value to set')
    .action(async (key: string, value?: string) => {
      const secretStore = new PlaintextSecretStore();
      const configStore = new JsonConfigStore(getConfigDir());
      const configService = new ConfigService(configStore, secretStore);

      switch (key) {
        case 'api-key': {
          const apiKey = value ?? await prompt('OpenRouter API Key: ');
          if (!apiKey) {
            console.error('No API key provided.');
            process.exit(1);
          }
          await configService.saveApiKey(apiKey);
          console.log('API key saved.');
          break;
        }
        case 'chairman': {
          if (!value) {
            console.error('Usage: concilium config set chairman <cli[:model] or OpenRouter model id>');
            process.exit(1);
          }
          await configService.saveCouncilConfig({ chairmanModel: value });
          console.log(`Chairman model set to: ${value}`);
          break;
        }
        case 'jurors': {
          if (!value) {
            console.error('Usage: concilium config set jurors <member1,member2,...> (cli[:model] or OpenRouter model ids)');
            process.exit(1);
          }
          const models = value.split(',').map((s) => s.trim()).filter(Boolean);
          await configService.saveCouncilConfig({ councilModels: models });
          console.log(`Juror models set to: ${models.join(', ')}`);
          break;
        }
        default: {
          if (!(SAVED_ROLES as readonly string[]).includes(key)) {
            console.error(`Unknown config key: ${key}. Valid keys: api-key, chairman, jurors, ${SAVED_ROLES.join(', ')}`);
            process.exit(1);
          }
          if (!value) {
            console.error(`Usage: concilium config set ${key} <cli[:model]${isListRole(key as RoleName) ? ',...' : ''}>`);
            process.exit(1);
          }
          try {
            const roles = parseRoleFlags([`${key}=${value}`], roleOrigin.flag('config set'));
            await configService.saveRoles(roles);
            const saved = roles[key as RoleName]!;
            console.log(`Role ${key} set to: ${Array.isArray(saved) ? saved.join(', ') : saved}`);
          } catch (err) {
            printError(err);
            process.exit(1);
          }
        }
      }
    });

  config
    .command('reset')
    .description('Reset configuration to defaults')
    .action(async () => {
      const configStore = new JsonConfigStore(getConfigDir());
      await configStore.saveCouncilConfigPrefs({});
      console.log('Configuration reset to defaults.');
    });

  config
    .command('path')
    .description('Print the config file location')
    .action(() => {
      console.log(getConfigDir());
    });

  // Default: show config when no subcommand
  config.action(async () => {
    // Execute 'show' by default
    await config.commands.find((c) => c.name() === 'show')?.parseAsync([], { from: 'user' });
  });
}
