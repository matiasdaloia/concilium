import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { render as inkRender } from 'ink';
import type { Command } from 'commander';
import {
  DeliberationService,
  OpenRouterGateway,
  ClaudeProvider,
  CodexProvider,
  OpenCodeProvider,
  JsonRunRepository,
  JsonConfigStore,
  ConfigService,
  setLogLevel,
  type AgentInstance,
  type AgentProvider,
  type RunRecord,
} from '@concilium/core';
import { createCallbackEventBridge } from '../adapters/callback-event-bridge.js';
import { TerminalSecretStore } from '../adapters/terminal-secret-store.js';
import { getConfigDir, getDataDir } from '../adapters/xdg-paths.js';
import { App } from '../ui/App.js';
import {
  deliberationReducer,
  initialState,
  type Action,
  type DeliberationState,
} from '../ui/hooks/useDeliberation.js';

interface RunOptions {
  file?: string;
  agents?: string;
  jurorModels?: string;
  jurors?: string;
  chairman?: string;
  stage1Only?: boolean;
  cwd?: string;
  json?: boolean;
  format?: string;
  output?: string;
  noSave?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

function buildProviders(): Map<string, AgentProvider> {
  const providers = new Map<string, AgentProvider>();
  providers.set('claude', new ClaudeProvider());
  providers.set('codex', new CodexProvider());
  providers.set('opencode', new OpenCodeProvider());
  return providers;
}

function parseAgentsFlag(agents?: string): AgentInstance[] {
  if (!agents) {
    // Default: two opencode instances
    return [
      { instanceId: crypto.randomUUID(), provider: 'opencode', model: '', enabled: true },
      { instanceId: crypto.randomUUID(), provider: 'opencode', model: '', enabled: true },
    ];
  }

  return agents.split(',').map((spec) => {
    const [provider, model] = spec.includes(':') ? spec.split(':', 2) : [spec, ''];
    return {
      instanceId: crypto.randomUUID(),
      provider: provider.trim() as 'claude' | 'codex' | 'opencode',
      model: model?.trim() ?? '',
      enabled: true,
    };
  });
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a deliberation pipeline')
    .argument('[prompt...]', 'The prompt to deliberate on')
    .option('-f, --file <path>', 'Read prompt from file (- for stdin)')
    .option('--agents <list>', 'Agents to use (e.g. "claude,codex" or "claude:opus,codex:gpt-5.2-codex")')
    .option('--juror-models <list>', 'Juror models (comma-separated OpenRouter model IDs)')
    .option('--jurors <n>', 'Number of juror models (uses defaults)')
    .option('--chairman <model>', 'Chairman model (OpenRouter model ID)')
    .option('--stage1-only', 'Skip council stages (just run agents)')
    .option('--cwd <path>', 'Project working directory', process.cwd())
    .option('--json', 'Output as JSON to stdout')
    .option('--format <type>', 'Output format: interactive (default), md, plain')
    .option('--output <file>', 'Save synthesis to file')
    .option('--no-save', "Don't persist run to history")
    .option('--verbose', 'Debug logging')
    .option('--quiet', 'Minimal output')
    .action(async (promptParts: string[], opts: RunOptions) => {
      if (opts.verbose) setLogLevel('debug');
      if (opts.quiet) setLogLevel('error');

      // Resolve prompt
      let prompt: string;
      if (opts.file) {
        if (opts.file === '-') {
          prompt = readFileSync('/dev/stdin', 'utf-8').trim();
        } else {
          prompt = readFileSync(resolve(opts.file), 'utf-8').trim();
        }
      } else if (promptParts.length > 0) {
        prompt = promptParts.join(' ');
      } else {
        console.error('Error: No prompt provided. Use `concilium run <prompt>` or `concilium run -f <file>`');
        process.exit(1);
      }

      const cwd = resolve(opts.cwd ?? process.cwd());
      const agentInstances = parseAgentsFlag(opts.agents);
      const isJson = opts.json || !process.stdout.isTTY;
      const isQuiet = opts.quiet ?? false;

      // Set up dependencies
      const secretStore = new TerminalSecretStore();
      const configStore = new JsonConfigStore(getConfigDir());
      const configService = new ConfigService(configStore, secretStore);
      const config = await configService.resolve();

      // Override council config from flags
      if (opts.jurorModels) {
        config.councilModels = opts.jurorModels.split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (opts.chairman) {
        config.chairmanModel = opts.chairman;
      }

      const llmGateway = new OpenRouterGateway(config.openRouterApiKey, config.openRouterApiUrl);
      const providers = buildProviders();

      // Build no-op or JSON run repository
      const runRepository = opts.noSave
        ? { save: async () => '', load: async () => ({} as RunRecord), list: async () => [], loadAll: async () => [] }
        : new JsonRunRepository(getDataDir());

      const isInteractive = process.stdout.isTTY && !isJson && !isQuiet;

      // --- Interactive mode: Ink UI ---
      if (isInteractive) {
        // Suppress info/debug logs that would corrupt Ink's rendering.
        // Errors still flow to stderr which Ink tolerates.
        if (!opts.verbose) setLogLevel('error');

        let state: DeliberationState = { ...initialState };

        const dispatch = (action: Action) => {
          state = deliberationReducer(state, action);
          ink.rerender(React.createElement(App, { state }));
        };

        const ink = inkRender(React.createElement(App, { state }));

        const events = createCallbackEventBridge({
          onStageChange: (stage, summary) => dispatch({ type: 'STAGE_CHANGE', stage, summary }),
          onAgentStatus: (key, status, name) => dispatch({ type: 'AGENT_STATUS', key, status, name }),
          onAgentEvent: (key, event) => dispatch({ type: 'AGENT_EVENT', key, event }),
          onJurorStatus: (model, status) => dispatch({ type: 'JUROR_STATUS', model, status }),
          onJurorChunk: (model) => dispatch({ type: 'JUROR_CHUNK', model }),
          onJurorComplete: (model, success, usage) => dispatch({ type: 'JUROR_COMPLETE', model, success, usage }),
          onSynthesisStart: () => dispatch({ type: 'SYNTHESIS_START' }),
          onComplete: (record) => {
            dispatch({ type: 'COMPLETE', record });

            if (opts.output && record.stage3?.response) {
              writeFileSync(resolve(opts.output), record.stage3.response, 'utf-8');
            }

            // Brief delay so the final frame renders before unmount
            setTimeout(() => ink.unmount(), 100);
          },
          onError: (error) => {
            dispatch({ type: 'ERROR', error });
            setTimeout(() => {
              ink.unmount();
              process.exit(1);
            }, 100);
          },
        });

        const service = new DeliberationService({
          providers,
          llmGateway,
          configStore,
          secretStore,
          runRepository,
          events,
        });

        try {
          await service.run({ prompt, images: [], agentInstances, cwd });
          await ink.waitUntilExit();
        } catch (err) {
          ink.unmount();
          console.error(`\nDeliberation failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }

        return;
      }

      // --- Non-interactive mode: plain console output (JSON / quiet / no TTY) ---
      let currentStage = 0;
      const agentNames = new Map<string, string>();

      const events = createCallbackEventBridge({
        onStageChange: (stage, summary) => {
          currentStage = stage;
          if (!isJson && !isQuiet) {
            console.log(`\n  Stage ${stage}: ${summary}\n`);
          }
        },
        onAgentStatus: (agentKey, status, name) => {
          if (name) agentNames.set(agentKey, name);
          if (!isJson && !isQuiet) {
            const displayName = agentNames.get(agentKey) ?? agentKey;
            const icon = status === 'success' ? '\u2713' : status === 'error' ? '\u2717' : status === 'running' ? '\u25B6' : '\u25CB';
            console.log(`  ${icon} ${displayName}: ${status}`);
          }
        },
        onAgentEvent: () => {},
        onJurorStatus: (model, status) => {
          if (!isJson && !isQuiet) {
            const icon = status === 'complete' ? '\u2713' : status === 'evaluating' ? '\u25B6' : '\u25CB';
            console.log(`  ${icon} ${model}: ${status}`);
          }
        },
        onJurorChunk: () => {},
        onJurorComplete: () => {},
        onSynthesisStart: () => {
          if (!isJson && !isQuiet) {
            console.log('\n  Chairman producing final answer...\n');
          }
        },
        onComplete: (record) => {
          if (isJson) {
            console.log(JSON.stringify(record, null, 2));
          } else {
            console.log('\n' + '='.repeat(60));
            console.log('  SYNTHESIS');
            console.log('='.repeat(60) + '\n');
            console.log(record.stage3?.response ?? 'No synthesis available.');
            console.log('\n' + '-'.repeat(60));

            const stage2Costs = record.stage2.reduce((sum, r) => sum + (r.estimatedCost ?? 0), 0);
            const stage3Cost = record.stage3?.estimatedCost ?? 0;
            const totalCost = stage2Costs + stage3Cost;
            if (totalCost > 0) {
              console.log(`  Cost: $${totalCost.toFixed(4)}`);
            }
            console.log(`  Run saved: ${record.id}`);
            console.log();
          }

          if (opts.output && record.stage3?.response) {
            writeFileSync(resolve(opts.output), record.stage3.response, 'utf-8');
            if (!isJson) {
              console.log(`  Synthesis saved to: ${opts.output}`);
            }
          }
        },
        onError: (error) => {
          if (isJson) {
            console.error(JSON.stringify({ error }));
          } else {
            console.error(`\n  Error: ${error}\n`);
          }
        },
      });

      const service = new DeliberationService({
        providers,
        llmGateway,
        configStore,
        secretStore,
        runRepository,
        events,
      });

      try {
        await service.run({ prompt, images: [], agentInstances, cwd });
      } catch (err) {
        if (!isJson) {
          console.error(`\nDeliberation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(1);
      }
    });
}
