/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  checkRoleFamilies,
  createConciliumRuntime,
  GitWorktreeWorkspace,
  JsonCodeRunStore,
  JsonConfigStore,
  JsonRunRepository,
  parseCommandRoles,
  PlaintextSecretStore,
  runFactory,
  specAgent,
  throwOnRoleErrors,
  type FactoryRecord,
} from '@concilium/core';
import { getConfigDir, getDataDir, getWorktreeRoot } from '../adapters/xdg-paths.js';
import { factoryLines } from '../formatters/factory.js';
import { printError, violationLines } from '../formatters/roles.js';
import { REFRAME_EXIT_CODE } from './code.js';
import { collect } from './roles.js';

interface FactoryOptions {
  cwd: string;
  agents?: string;
  role?: string[];
  timeout?: string;
  adversarial: boolean;
  judge: boolean;
  json?: boolean;
}

/** 0 when every task shipped, 2 when a task ended in reframe-needed, else 1. */
export function factoryExitCode(record: FactoryRecord): number {
  if (record.status === 'done') return 0;
  return record.steps.some((s) => s.outcome === 'stopped' && s.runStatus === 'reframe-needed') ? REFRAME_EXIT_CODE : 1;
}

export function registerFactoryCommand(program: Command): void {
  program
    .command('factory')
    .description('Plan a spec into tasks, one code run each')
    .argument('<spec>', 'A file holding the spec')
    .option('--cwd <path>', 'Directory of the git repo to work on', process.cwd())
    .option('--agents <list>', 'Candidate agents for every task, the implementer role (default: the installed, signed-in agent CLIs)')
    .option('--role <role=members>', 'Who plays a role: planner (splits the spec), implementer, adversary, judge, integrator or verifier, as cli[:model]; repeatable', collect)
    .option('--timeout <minutes>', 'Wall-clock limit per candidate and per adversary in minutes, in every task')
    .option('--no-adversarial', 'Skip the adversarial round in every task')
    .option('--no-judge', 'Do not ask a judge CLI to order tied candidates in any task')
    .option('--json', 'Output the factory record as JSON to stdout')
    .action(async (specFile: string, opts: FactoryOptions) => {
      const fail = (err: unknown): never => {
        printError(err, opts.json);
        process.exit(1);
      };
      const timeoutMinutes = opts.timeout === undefined ? undefined : Number(opts.timeout);
      if (timeoutMinutes !== undefined && !(timeoutMinutes > 0)) fail(`--timeout must be a positive number of minutes, got "${opts.timeout}"`);
      const spec = await readFile(resolve(specFile), 'utf8').catch(() => fail(`cannot read the spec file ${specFile}`));
      if (!spec.trim()) fail(`the spec file ${specFile} is empty`);

      const runtime = createConciliumRuntime({
        secretStore: new PlaintextSecretStore(),
        configStore: new JsonConfigStore(getConfigDir()),
        runRepository: new JsonRunRepository(getDataDir()),
      });
      const progress = (line: string) => !opts.json && console.error(line);
      const repoDir = resolve(opts.cwd);
      const store = new JsonCodeRunStore(getDataDir());
      let record: FactoryRecord;
      try {
        // The role rules run before the planner does: an error stops here, a warning is printed.
        const { verifier, ...codeFlags } = parseCommandRoles('factory', { roles: opts.role, agents: opts.agents });
        const roles = await runtime.resolveCodeRoles({ repoDir, flags: codeFlags });
        const verifierRole = await runtime.resolveVerifier({ repoDir, flags: verifier === undefined ? {} : { verifier } });
        for (const line of violationLines(throwOnRoleErrors(checkRoleFamilies({ roles, verifier: verifierRole })))) progress(`  ${line}`);
        const agents = roles.implementer.value.map(specAgent);
        if (agents.length === 0 || !roles.planner.value) fail('no implementer to run');

        record = await runFactory({
          spec,
          specPath: specFile,
          repoDir,
          planner: roles.planner.value,
          verifier: verifierRole.value,
          code: {
            agents, roles, drivers: runtime.drivers, workspace: new GitWorktreeWorkspace({ root: getWorktreeRoot() }),
            timeoutMs: timeoutMinutes === undefined ? undefined : timeoutMinutes * 60_000, adversarial: opts.adversarial, judge: opts.judge,
            onCandidateDone: (c) => progress(`    ${c.status === 'ok' ? '✓' : '✗'} ${c.candidateId}: ${c.status}`),
          },
          runDir: (id) => store.runDir(id),
          saveRun: (run) => store.save(run),
          onPlanned: (tasks, dir) => progress(`  Planned ${tasks.length} tasks (${tasks.map((t) => t.id).join(', ')}) in ${dir}`),
          onTaskStart: (task, runId, base) => progress(`  ▶ ${task.id} (${task.type}): run ${runId} from ${base.slice(0, 12)}`),
          onVerifyStep: (line) => progress(`    ${line}`),
          onTaskDone: (step) => progress(`  ${step.outcome === 'shipped' ? `✓ ${step.taskId}: ${step.verdict} at ${step.headSha.slice(0, 12)}` : `✗ ${step.taskId}: ${step.outcome === 'stopped' ? step.reason : step.outcome}`}`),
        });
      } catch (err) {
        return fail(err);
      }

      if (opts.json) console.log(JSON.stringify(record, null, 2));
      else for (const line of factoryLines(record, store.runDir(record.id))) console.log(line);
      process.exitCode = factoryExitCode(record);
    });
}
