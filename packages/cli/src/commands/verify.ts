import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  DeliberationService,
  OpenRouterGateway,
  OpenCodeProvider,
  GitHubRestGateway,
  parsePrUrl,
  JsonRunRepository,
  JsonConfigStore,
  ConfigService,
  calculateConfidence,
  buildVerifyReport,
  buildVerifyPrompt,
  discoverContext,
  formatDiscoveredContext,
  setLogLevel,
  PRESET_MODELS,
  isValidPreset,
  type AgentInstance,
  type AgentProvider,
  type ModelPreset,
} from '@concilium/core';
import { createCallbackEventBridge } from '../adapters/callback-event-bridge.js';
import { TerminalSecretStore } from '../adapters/terminal-secret-store.js';
import { getConfigDir, getDataDir } from '../adapters/xdg-paths.js';
import { formatVerifyReport, type VerifyOutputFormat } from '../formatters/verify.js';


interface VerifyOptions {
  pr?: string;
  repo?: string;
  prNumber?: string;
  models?: string;
  preset?: string;
  jurorModels?: string;
  chairman?: string;
  threshold?: string;
  format?: string;
  output?: string;
  noPost?: boolean;
  noSave?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  cwd?: string;
  focusFiles?: string;
  customInstructions?: string;
}

function buildAgentInstances(models: string[]): AgentInstance[] {
  return models.map((model) => ({
    instanceId: crypto.randomUUID(),
    provider: 'opencode' as const,
    model,
    enabled: true,
  }));
}

function buildProviders(): Map<string, AgentProvider> {
  const providers = new Map<string, AgentProvider>();
  providers.set('opencode', new OpenCodeProvider());
  return providers;
}

function resolveModels(modelsFlag: string | undefined, preset: ModelPreset): string[] {
  if (modelsFlag) {
    return modelsFlag.split(',').map((m) => m.trim());
  }
  return PRESET_MODELS[preset];
}

export function registerVerifyCommand(program: Command): void {
  program
    .command('verify')
    .description('Run multi-agent code review on a PR with confidence scoring')
    .option('--pr <url>', 'GitHub PR URL (e.g. https://github.com/owner/repo/pull/123)')
    .option('--repo <owner/repo>', 'Repository (alternative to --pr)')
    .option('--pr-number <n>', 'PR number (used with --repo)')
    .option('--models <list>', 'OpenRouter models for review agents (comma-separated)')
    .option('--preset <fast|balanced|thorough>', 'Model preset (default: fast)', 'fast')
    .option('--juror-models <list>', 'Juror models for ranking (comma-separated)')
    .option('--chairman <model>', 'Chairman model for synthesis')
    .option('--threshold <0-100>', 'Confidence threshold for PASS/FAIL', '70')
    .option('--format <json|text|markdown>', 'Output format')
    .option('--output <file>', 'Save report to file')
    .option('--no-post', 'Skip posting review comment to GitHub')
    .option('--no-save', "Don't persist run to history")
    .option('--verbose', 'Debug logging')
    .option('--quiet', 'Minimal output')
    .option('--cwd <path>', 'Project working directory', process.cwd())
    .option('--focus-files <list>', 'Comma-separated files to focus review on')
    .option('--custom-instructions <text>', 'Additional review instructions')
    .action(async (opts: VerifyOptions) => {
      const startTime = Date.now();

      if (opts.verbose) setLogLevel('debug');
      if (opts.quiet) setLogLevel('error');

      // Resolve PR info
      let owner: string, repo: string, prNumber: number;
      try {
        if (opts.pr) {
          ({ owner, repo, prNumber } = parsePrUrl(opts.pr));
        } else if (opts.repo && opts.prNumber) {
          const [o, r] = opts.repo.split('/');
          owner = o;
          repo = r;
          prNumber = parseInt(opts.prNumber, 10);
        } else {
          console.error('Error: --pr <url> or --repo <owner/repo> --pr-number <n> required');
          process.exit(2);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(2);
      }

      const workingDir = resolve(opts.cwd ?? process.cwd());

      // ── Context Discovery ──
      // Auto-detect project conventions, review guidelines, MCP servers
      if (!opts.quiet) console.error('Discovering project context...');
      const discoveredContext = discoverContext(workingDir);
      const projectContext = formatDiscoveredContext(discoveredContext);

      if (!opts.quiet && discoveredContext.conventions.length > 0) {
        const files = discoveredContext.conventions.map((c) => c.path).join(', ');
        console.error(`  Found: ${files}`);
      }
      if (!opts.quiet && discoveredContext.mcpServers.length > 0) {
        console.error(`  MCP servers: ${discoveredContext.mcpServers.map((s) => s.name).join(', ')}`);
      }

      // ── Config Resolution ──
      const configDir = getConfigDir();
      const dataDir = getDataDir();
      const secretStore = new TerminalSecretStore();
      const configStore = new JsonConfigStore(configDir);
      const configService = new ConfigService(configStore, secretStore);

      let config;
      try {
        config = await configService.resolve();
      } catch (err) {
        console.error(`Config error: ${(err as Error).message}`);
        process.exit(2);
      }

      if (opts.jurorModels) {
        config.councilModels = opts.jurorModels.split(',').map((m) => m.trim());
      }
      if (opts.chairman) {
        config.chairmanModel = opts.chairman;
      }

      // ── Preset Resolution ──
      const preset: ModelPreset = isValidPreset(opts.preset ?? '') ? (opts.preset as ModelPreset) : 'fast';
      const gateway = new OpenRouterGateway(config.openRouterApiKey, config.openRouterApiUrl);

      // ── Fetch PR Diff ──
      const githubGateway = new GitHubRestGateway();
      let diff;
      try {
        diff = await githubGateway.fetchPrDiff(owner, repo, prNumber);
      } catch (err) {
        console.error(`GitHub API error: ${(err as Error).message}`);
        process.exit(2);
      }

      if (!opts.quiet) {
        console.error(`PR: ${owner}/${repo}#${prNumber} — ${diff.title}`);
        console.error(`  ${diff.files.length} files changed (+${diff.files.reduce((s, f) => s + f.additions, 0)} -${diff.files.reduce((s, f) => s + f.deletions, 0)})`);
      }

      // ── Build Prompt with Context ──
      const prompt = buildVerifyPrompt(diff, {
        focusFiles: opts.focusFiles?.split(',').map((f) => f.trim()),
        customInstructions: opts.customInstructions,
        projectContext: projectContext || undefined,
      });

      // ── Resolve Models & Agents ──
      // All agents are OpenCode instances, each running a different OpenRouter model
      const models = resolveModels(opts.models, preset);
      const agentInstances = buildAgentInstances(models);
      const providers = buildProviders();

      if (!opts.quiet) {
        console.error(`Running ${models.length} agents: ${models.join(', ')}`);
      }

      const runRepository = opts.noSave
        ? { save: async () => '', load: async () => ({} as any), list: async () => [], loadAll: async () => [] }
        : new JsonRunRepository(dataDir);

      const threshold = parseInt(opts.threshold ?? '70', 10);

      // ── Event Bridge (CI-friendly) ──
      const events = createCallbackEventBridge({
        onStageChange: (stage, summary) => {
          if (!opts.quiet) console.error(`[Stage ${stage}] ${summary}`);
        },
        onAgentStatus: (key, status) => {
          if (!opts.quiet) console.error(`  Agent ${key}: ${status}`);
        },
        onError: (error) => console.error(`Error: ${error}`),
      });

      // ── Run Deliberation ──
      const service = new DeliberationService({
        providers,
        llmGateway: gateway,
        configStore,
        secretStore,
        runRepository,
        events,
      });

      let record;
      try {
        record = await service.run({
          prompt,
          agentInstances,
          cwd: workingDir,
        });
      } catch (err) {
        console.error(`Pipeline error: ${(err as Error).message}`);
        process.exit(2);
      }

      // ── Confidence Scoring ──
      const confidence = calculateConfidence(
        record.stage2,
        record.stage1,
        record.metadata.aggregateRankings,
        record.metadata.labelToModel,
        threshold,
      );

      const durationMs = Date.now() - startTime;
      const report = buildVerifyReport(
        record,
        confidence,
        prNumber,
        `${owner}/${repo}`,
        threshold,
        durationMs,
      );

      // ── Persist ──
      record.mode = 'verify';
      record.verdict = report.verdict;
      record.confidence = report.confidence;
      if (!opts.noSave) {
        await runRepository.save(record);
      }

      // ── Output ──
      const format: VerifyOutputFormat = (opts.format as VerifyOutputFormat)
        ?? (process.stdout.isTTY ? 'text' : 'json');
      const output = formatVerifyReport(report, format);
      console.log(output);

      if (opts.output) {
        writeFileSync(resolve(opts.output), formatVerifyReport(report, 'json'));
      }

      // ── Post to GitHub ──
      if (!opts.noPost && process.env.GITHUB_TOKEN) {
        try {
          const markdown = formatVerifyReport(report, 'markdown');
          await githubGateway.postReviewComment(owner, repo, prNumber, markdown);
          if (!opts.quiet) console.error('Review comment posted to PR.');
        } catch (err) {
          console.error(`Warning: Failed to post comment: ${(err as Error).message}`);
        }
      }

      // Exit code: 0 = PASS, 1 = FAIL, 2 = error (handled above)
      process.exit(report.verdict === 'PASS' ? 0 : 1);
    });
}
