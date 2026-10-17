/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { createHash } from 'node:crypto';
import { isTaskType, TASK_TYPES, type TaskType } from './playbooks.js';
import { jsonFromAnswer } from './rubric.js';
import { shipSource, type PrVerdictStatus } from './shipping.js';

/** The factory record, the task list and its rendering, in the factory's run directory. */
export const FACTORY_RECORD = 'factory.json';
export const TASKS_FILE = 'tasks.json';
export const TASKS_REPORT = 'tasks.md';

/** One task of a spec: one code council run, on the commit the tasks before it shipped. */
export type FactoryTask = {
  id: string;
  title: string;
  type: TaskType;
  /** Checkable lines; every candidate brief holds them. */
  acceptance: string[];
  /** Ids of tasks that must ship first. */
  dependsOn: string[];
};

export class TaskListValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`task list rejected: ${problems.join('; ')}`);
    this.name = 'TaskListValidationError';
  }
}

/** The prompt for the planner's one read-only run that splits a spec into tasks. */
export function planPrompt(spec: string): string {
  return [
    'You are planning the work for the spec below. Split it into the fewest tasks that one coding agent can each implement and verify on its own.',
    'Each task is run on top of the tasks it depends on. Each task has:',
    '- id: short kebab-case id, unique',
    '- title: one sentence a stranger could act on',
    `- type: one of ${TASK_TYPES.join(', ')}`,
    '- acceptance: a list of checkable lines, at least one',
    '- depends_on: the ids of the tasks that must land first ([] for none)',
    '',
    'Do not write code and do not write any files. Reply with only a JSON object: {"tasks": [...]}.',
    '',
    `Spec:\n${spec}`,
  ].join('\n');
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.map((v) => v.trim()) : null;
}

/** The ids left in a dependency cycle (Kahn's algorithm leaves them unvisited), in list order. */
function cycleMembers(tasks: FactoryTask[]): string[] {
  const order = taskOrder(tasks);
  const placed = new Set(order.map((t) => t.id));
  return tasks.filter((t) => !placed.has(t.id)).map((t) => t.id);
}

/**
 * Validates a task list (`{"tasks": [...]}` or a bare array, `depends_on` per task) and names every problem at once:
 * no tasks, a missing id or title, a duplicate id, an unknown type, no acceptance line, an unknown dependency, a cycle.
 */
export function parseTaskList(value: unknown): FactoryTask[] {
  const list = Array.isArray(value) ? value : (value as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(list) || list.length === 0) throw new TaskListValidationError(['tasks: a non-empty list is required']);
  const problems: string[] = [];
  const tasks: FactoryTask[] = list.map((raw: unknown, i) => {
    const at = `tasks[${i}]`;
    const t = (raw ?? {}) as Record<string, unknown>;
    const id = typeof t.id === 'string' ? t.id.trim() : '';
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    const acceptance = (strings(t.acceptance) ?? []).filter(Boolean);
    const dependsOn = t.depends_on === undefined ? [] : strings(t.depends_on);
    if (!id) problems.push(`${at}.id: required`);
    if (!title) problems.push(`${at}.title: required`);
    if (typeof t.type !== 'string' || !isTaskType(t.type)) problems.push(`${at}.type: must be one of ${TASK_TYPES.join(', ')}`);
    if (acceptance.length === 0) problems.push(`${at}.acceptance: at least one line is required`);
    if (!dependsOn) problems.push(`${at}.depends_on: must be a list of task ids`);
    return { id, title, type: t.type as TaskType, acceptance, dependsOn: dependsOn ?? [] };
  });
  const ids = tasks.map((t) => t.id);
  for (const [i, t] of tasks.entries()) {
    if (t.id && ids.indexOf(t.id) !== i) problems.push(`tasks[${i}].id: "${t.id}" is used twice`);
    for (const dep of t.dependsOn) if (!ids.includes(dep)) problems.push(`tasks[${i}].depends_on: unknown task "${dep}"`);
  }
  if (problems.length === 0) {
    const cycle = cycleMembers(tasks);
    if (cycle.length > 0) problems.push(`depends_on: a cycle among ${cycle.join(', ')}`);
  }
  if (problems.length > 0) throw new TaskListValidationError(problems);
  return tasks;
}

/** Reads the task list out of a planner's answer, bare or in a code fence. */
export function parseTaskAnswer(text: string): FactoryTask[] {
  let parsed: unknown;
  try {
    parsed = jsonFromAnswer(text);
  } catch (err) {
    throw new TaskListValidationError([`answer: ${(err as Error).message}`]);
  }
  return parseTaskList(parsed);
}

/**
 * Dependency order: a task comes after every task it depends on, and otherwise keeps its place in the list. Tasks in
 * a cycle are left out (`parseTaskList` rejects a list with one).
 */
export function taskOrder(tasks: FactoryTask[]): FactoryTask[] {
  const order: FactoryTask[] = [];
  const done = new Set<string>();
  let next: FactoryTask | undefined;
  while ((next = tasks.find((t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d))))) {
    order.push(next);
    done.add(next.id);
  }
  return order;
}

/** What the candidates of a task are asked to do: its title and its acceptance lines. */
export function taskBrief(task: FactoryTask): string {
  return [task.title, '', 'Acceptance (each line must hold when you finish):', ...task.acceptance.map((line) => `- ${line}`)].join('\n');
}

export function specHash(spec: string): string {
  return createHash('sha256').update(spec).digest('hex');
}

/** `tasks.md`: the tasks in run order, with their type, dependencies and acceptance lines. */
export function tasksMarkdown(tasks: FactoryTask[], spec: { path: string; sha256: string }): string {
  return [
    `# Tasks for ${spec.path}`,
    '',
    `Spec sha256 \`${spec.sha256}\`. In run order; each task starts from the commit the one before it shipped.`,
    '',
    ...tasks.flatMap((t, i) => [
      `## ${i + 1}. ${t.id}: ${t.title}`,
      '',
      `Type: ${t.type}. Depends on: ${t.dependsOn.length ? t.dependsOn.join(', ') : 'nothing'}.`,
      '',
      ...t.acceptance.map((line) => `- ${line}`),
      '',
    ]),
  ].join('\n');
}

/**
 * One task's outcome. `shipped`: its commit was verified and the next task starts from it. `stopped`: the chain ends
 * here. `not-run`: an earlier task stopped the chain.
 */
export type FactoryStep =
  | {
    taskId: string; outcome: 'shipped'; runId: string; baseSha: string; branch: string; headSha: string;
    verdict: 'PASS' | 'PASS+NOTES'; verdictReason: string; sameFamily: boolean;
  }
  | {
    taskId: string; outcome: 'stopped'; runId: string; baseSha: string; reason: string;
    runStatus: 'done' | 'reframe-needed' | null; verdict: PrVerdictStatus | null;
  }
  | { taskId: string; outcome: 'not-run'; reason: string };

export type FactoryStatus = 'running' | 'done' | 'stopped';

export type FactoryRecord = {
  version: 1;
  kind: 'factory';
  id: string;
  status: FactoryStatus;
  createdAt: string;
  finishedAt: string | null;
  repoDir: string;
  specPath: string;
  specSha256: string;
  /** The planner that split the spec (`cli[:model]`). */
  planner: string;
  /** `HEAD` of the checkout when the factory started: the first task's base. */
  baseSha: string;
  /** In run order. */
  tasks: FactoryTask[];
  /** One per task, in run order, as far as the chain got. */
  steps: FactoryStep[];
  /** The task that stopped the chain, or null. */
  stoppedAt: string | null;
};

/** The parts of a code run the stop rule reads. */
export type TaskRun = {
  status: 'done' | 'reframe-needed';
  synthesis?: Parameters<typeof shipSource>[0]['synthesis'];
  candidates: { candidateId: string; provider: string; branch: string; headSha: string | null; status: string }[];
};

/** Why a finished task run has no head to verify, or null when it has one. */
export function unshippable(run: TaskRun): string | null {
  if (run.status === 'reframe-needed') return 'the run ended in reframe-needed: the task needs restating';
  if (run.candidates.every((c) => c.status !== 'ok')) return 'every candidate failed';
  const source = shipSource(run);
  return 'blocked' in source ? source.blocked : null;
}

/** Only a passing verdict on a commit lets the next task start from it. */
export function verdictStop(v: { verdict: PrVerdictStatus; reason: string; headSha: string | null }): string | null {
  if (!v.headSha) return `no verified commit (${v.verdict}: ${v.reason})`;
  if (v.verdict !== 'PASS' && v.verdict !== 'PASS+NOTES') return `the verdict is ${v.verdict}: ${v.reason}`;
  return null;
}
