/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FACTORY_RECORD,
  parseTaskAnswer,
  planPrompt,
  specHash,
  taskBrief,
  taskOrder,
  TASKS_FILE,
  TASKS_REPORT,
  tasksMarkdown,
  unshippable,
  verdictStop,
  type FactoryRecord,
  type FactoryStep,
  type FactoryTask,
} from '../domain/code-council/factory.js';
import type { PrVerdict } from '../domain/code-council/shipping.js';
import { CliCouncilGateway } from '../adapters/cli/cli-council-gateway.js';
import { refHead } from '../adapters/git-worktree-workspace.js';
import { createLogger } from '../shared/logger.js';
import { FRAME_TIMEOUT_MS, newRunId, runCodeCandidates, type CodeRunInput, type CodeRunRecord } from './code-service.js';
import { verifyPr } from './pr-service.js';

const log = createLogger('factory');

/** What every task's code run shares. Each run is verified, synthesized and keeps its decision trail. */
export type FactoryCodeOptions = Pick<
  CodeRunInput,
  'agents' | 'roles' | 'drivers' | 'workspace' | 'timeoutMs' | 'adversarial' | 'judge' | 'signal'
  | 'onFramed' | 'onCandidateStart' | 'onCandidateDone' | 'onGateDone' | 'onAdversaryDone' | 'onTestDone' | 'onJudgeDone' | 'onGraftDone'
>;

export type FactoryInput = {
  spec: string;
  /** Where the spec was read from, as given; recorded with its hash. */
  specPath: string;
  /** Any directory inside the target repo. */
  repoDir: string;
  /** Splits the spec into tasks: `cli[:model]`, the planner role. */
  planner: string;
  /** The verifier role (`cli[:model]`), or `auto`/absent to pick one per task. */
  verifier?: string;
  /** The `allow-same-family-verifier` opt-in for every task's verdict (`VerifyPrInput.allowSameFamily`). */
  allowSameFamilyVerifier?: boolean;
  code: FactoryCodeOptions;
  /** The run directory for an id: the factory's own (`factory.json`, `tasks.json`, `tasks.md`) and each task run's. */
  runDir: (id: string) => string;
  /** Saves a task's code run record, so `concilium pr <run-id>` can ship it later. */
  saveRun: (record: CodeRunRecord) => Promise<unknown>;
  /** Defaults to a new id. */
  factoryId?: string;
  onPlanned?: (tasks: FactoryTask[], dir: string) => void;
  onTaskStart?: (task: FactoryTask, runId: string, baseSha: string) => void;
  onTaskDone?: (step: FactoryStep, record: CodeRunRecord | null) => void;
  onVerifyStep?: (line: string) => void;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The factory record in `dir`, or null when there is none. */
export async function loadFactory(dir: string): Promise<FactoryRecord | null> {
  const text = await readFile(join(dir, FACTORY_RECORD), 'utf8').catch(() => null);
  return text === null ? null : (JSON.parse(text) as FactoryRecord);
}

async function saveFactory(dir: string, record: FactoryRecord): Promise<void> {
  await writeFile(join(dir, FACTORY_RECORD), `${JSON.stringify(record, null, 2)}\n`);
}

/** The planner's one read-only run on the spec, parsed and validated. Throws `TaskListValidationError` on a bad list. */
async function planTasks(input: FactoryInput): Promise<FactoryTask[]> {
  const gateway = new CliCouncilGateway({ drivers: input.code.drivers, timeoutMs: FRAME_TIMEOUT_MS });
  const response = await gateway.query(input.planner, [{ role: 'user', content: planPrompt(input.spec) }], undefined, input.code.signal);
  if (!response) throw new Error(`the planner ${input.planner} gave no task list`);
  return taskOrder(parseTaskAnswer(response.content));
}

/**
 * M8.1. The planner splits the spec into tasks, validated and saved as `tasks.json` and `tasks.md`. Then one code
 * council per task in dependency order, one at a time: each starts from the commit the task before it shipped (the
 * first from `HEAD`), so the branches stack locally. Each task's commit is verified at its own head as `verify-pr`
 * does, and the verdict is saved on its run. The chain stops at the first task without a passing verdict on a
 * commit (a reframe, every candidate failed, nothing to ship, a verdict other than PASS or PASS+NOTES). Nothing is
 * pushed. `factory.json` is rewritten after every task.
 */
export async function runFactory(input: FactoryInput): Promise<FactoryRecord> {
  const id = input.factoryId ?? newRunId();
  const dir = input.runDir(id);
  const startSha = await refHead(input.repoDir, 'HEAD');
  if (!startSha) throw new Error(`${input.repoDir} has no commit to start from`);
  const { repoDir } = input;

  const tasks = await planTasks(input);
  const sha256 = specHash(input.spec);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, TASKS_FILE), `${JSON.stringify({ version: 1, specPath: input.specPath, specSha256: sha256, tasks }, null, 2)}\n`);
  await writeFile(join(dir, TASKS_REPORT), tasksMarkdown(tasks, { path: input.specPath, sha256 }));
  input.onPlanned?.(tasks, dir);

  const record: FactoryRecord = {
    version: 1, kind: 'factory', id, status: 'running', createdAt: new Date().toISOString(), finishedAt: null, repoDir,
    specPath: input.specPath, specSha256: sha256, planner: input.planner, baseSha: startSha, tasks, steps: [], stoppedAt: null,
  };
  await saveFactory(dir, record);

  let baseSha = startSha;
  // A stacked task merges into the task before it, so `mergeable` is checked there, never against the checkout.
  let mergeTarget = { sha: startSha, label: 'the factory base' };
  for (const task of tasks) {
    if (record.stoppedAt) {
      record.steps.push({ taskId: task.id, outcome: 'not-run', reason: `task ${record.stoppedAt} stopped the chain` });
      continue;
    }
    const runId = newRunId();
    input.onTaskStart?.(task, runId, baseSha);
    const stop = (reason: string, run: CodeRunRecord | null, verdict: PrVerdict | null): FactoryStep => ({
      taskId: task.id, outcome: 'stopped', runId, baseSha, reason, runStatus: run?.status ?? null, verdict: verdict?.verdict ?? null,
    });
    let step: FactoryStep;
    let run: CodeRunRecord | null = null;
    try {
      const runDir = input.runDir(runId);
      run = await runCodeCandidates({
        ...input.code, task: taskBrief(task), type: task.type, repoDir, runId, baseSha, verify: true, synthesis: { runDir, mergeTarget }, trail: { runDir },
      });
      await input.saveRun(run);
      const blocked = unshippable(run);
      if (blocked) step = stop(blocked, run, null);
      else {
        const verdict = await verifyPr({ record: run, runDir, drivers: input.code.drivers, verifier: input.verifier, allowSameFamily: input.allowSameFamilyVerifier, signal: input.code.signal, onStep: input.onVerifyStep });
        run.prVerdict = verdict;
        await input.saveRun(run);
        const failed = verdictStop(verdict);
        const v = verdict.verdict;
        step = !failed && verdict.headSha && verdict.branch && (v === 'PASS' || v === 'PASS+NOTES')
          ? {
            taskId: task.id, outcome: 'shipped', runId, baseSha, branch: verdict.branch, headSha: verdict.headSha,
            verdict: v, verdictReason: verdict.reason, sameFamily: verdict.verifier?.sameFamily ?? false,
          }
          : stop(failed ?? 'no verified commit', run, verdict);
      }
    } catch (err) {
      step = stop(`the run failed: ${errorMessage(err)}`, run, null);
    }
    record.steps.push(step);
    if (step.outcome === 'shipped') {
      baseSha = step.headSha;
      mergeTarget = { sha: step.headSha, label: `task ${task.id}'s head` };
    } else record.stoppedAt = task.id;
    log.info(`factory ${id}: task ${task.id} ${step.outcome}${step.outcome === 'stopped' ? ` (${step.reason})` : ''}`);
    input.onTaskDone?.(step, run);
    await saveFactory(dir, record);
  }

  record.status = record.stoppedAt ? 'stopped' : 'done';
  record.finishedAt = new Date().toISOString();
  await saveFactory(dir, record);
  return record;
}
