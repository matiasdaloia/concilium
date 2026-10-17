/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import {
  parseTaskAnswer, parseTaskList, planPrompt, taskBrief, taskOrder, tasksMarkdown, TaskListValidationError, unshippable, verdictStop,
  type FactoryTask, type TaskRun,
} from './factory.js';

const task = (id: string, depends_on: string[] = [], extra: object = {}) => ({ id, title: `do ${id}`, type: 'feature', acceptance: [`${id} works`], depends_on, ...extra });

function problems(value: unknown): string[] {
  try {
    parseTaskList(value);
  } catch (err) {
    expect(err).toBeInstanceOf(TaskListValidationError);
    return (err as TaskListValidationError).problems;
  }
  throw new Error('accepted');
}

describe('parseTaskList', () => {
  it('should accept a valid list, trimmed, with depends_on as dependsOn and a missing depends_on as none', () => {
    expect(parseTaskList({ tasks: [{ id: ' a ', title: ' add a ', type: 'bugfix', acceptance: [' a holds ', ''] }, task('b', ['a'])] })).toEqual([
      { id: 'a', title: 'add a', type: 'bugfix', acceptance: ['a holds'], dependsOn: [] },
      { id: 'b', title: 'do b', type: 'feature', acceptance: ['b works'], dependsOn: ['a'] },
    ]);
    expect(parseTaskList([task('a')])).toHaveLength(1);
  });

  it('should name every problem at once', () => {
    expect(problems({ tasks: [
      { id: '', title: '', type: 'chore', acceptance: [], depends_on: 'a' },
      task('b', ['ghost']),
      task('b'),
    ] })).toEqual([
      'tasks[0].id: required',
      'tasks[0].title: required',
      'tasks[0].type: must be one of bugfix, feature, refactor, perf, prototype',
      'tasks[0].acceptance: at least one line is required',
      'tasks[0].depends_on: must be a list of task ids',
      'tasks[1].depends_on: unknown task "ghost"',
      'tasks[2].id: "b" is used twice',
    ]);
  });

  it('should reject an empty list, no list, a cycle and a task depending on itself', () => {
    expect(problems({ tasks: [] })).toEqual(['tasks: a non-empty list is required']);
    expect(problems({ plan: [task('a')] })).toEqual(['tasks: a non-empty list is required']);
    expect(problems([task('a', ['c']), task('b', ['a']), task('c', ['b']), task('d')])).toEqual(['depends_on: a cycle among a, b, c']);
    expect(problems([task('a', ['a'])])).toEqual(['depends_on: a cycle among a']);
  });

  it('should reject an acceptance list holding only blank lines', () => {
    expect(problems([task('a', [], { acceptance: ['  '] })])).toEqual(['tasks[0].acceptance: at least one line is required']);
  });
});

describe('parseTaskAnswer', () => {
  it('should read a fenced answer and reject an answer with no JSON', () => {
    expect(parseTaskAnswer(`Here:\n\`\`\`json\n${JSON.stringify({ tasks: [task('a')] })}\n\`\`\``).map((t) => t.id)).toEqual(['a']);
    expect(() => parseTaskAnswer('no plan')).toThrow('answer: holds no JSON');
  });
});

describe('taskOrder', () => {
  it('should put each task after its dependencies and otherwise keep the list order', () => {
    const tasks = parseTaskList([task('c', ['b']), task('a'), task('b', ['a']), task('d')]);
    expect(taskOrder(tasks).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('task texts', () => {
  const tasks: FactoryTask[] = parseTaskList([task('a'), task('b', ['a'])]);

  it('should brief a task with its title and every acceptance line', () => {
    expect(taskBrief(tasks[1])).toBe('do b\n\nAcceptance (each line must hold when you finish):\n- b works');
  });

  it('should ask the planner for JSON only, with every field and type, and the spec last', () => {
    const prompt = planPrompt('# Spec\nship it');
    expect(prompt.startsWith('You are planning')).toBe(true);
    for (const word of ['id:', 'title:', 'type:', 'acceptance:', 'depends_on:', 'bugfix, feature, refactor, perf, prototype', '{"tasks": [...]}']) expect(prompt).toContain(word);
    expect(prompt.endsWith('Spec:\n# Spec\nship it')).toBe(true);
  });

  it('should render tasks.md in run order with the spec hash', () => {
    const md = tasksMarkdown(tasks, { path: 'spec.md', sha256: 'abc' });
    expect(md).toContain('# Tasks for spec.md\n\nSpec sha256 `abc`.');
    expect(md).toContain('## 1. a: do a\n\nType: feature. Depends on: nothing.\n\n- a works');
    expect(md).toContain('## 2. b: do b\n\nType: feature. Depends on: a.');
  });
});

describe('the stop rules', () => {
  const candidate = (id: string, status = 'ok') => ({ candidateId: id, provider: id, branch: `concilium/r/${id}`, headSha: `${id}-sha`, status });
  const run = (over: Partial<TaskRun> = {}): TaskRun => ({ status: 'done', candidates: [candidate('claude'), candidate('codex')], ...over });

  it('should stop at a reframe, when every candidate failed, and when there is nothing to ship', () => {
    expect(unshippable(run({ status: 'reframe-needed' }))).toMatch(/^the run ended in reframe-needed/);
    expect(unshippable(run({ candidates: [candidate('claude', 'error'), candidate('codex', 'rate_limited')] }))).toBe('every candidate failed');
    expect(unshippable(run())).toBe('the run has no integration branch');
  });

  it('should ship a single candidate that finished, per the ship rules', () => {
    expect(unshippable(run({ candidates: [candidate('claude')] }))).toBeNull();
    expect(unshippable(run({ candidates: [candidate('claude', 'error')] }))).toBe('every candidate failed');
  });

  it('should go on only from a passing verdict on a commit', () => {
    expect(verdictStop({ verdict: 'PASS', reason: 'ok', headSha: 'h' })).toBeNull();
    expect(verdictStop({ verdict: 'PASS+NOTES', reason: 'notes', headSha: 'h' })).toBeNull();
    expect(verdictStop({ verdict: 'FAIL', reason: 'gate test fails', headSha: 'h' })).toBe('the verdict is FAIL: gate test fails');
    expect(verdictStop({ verdict: 'BLOCKED', reason: 'no CLI', headSha: null })).toBe('no verified commit (BLOCKED: no CLI)');
  });
});
