/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { classifyTask, isTaskType, PLAYBOOKS, TASK_TYPES } from './playbooks.js';
import { parseRubricCriteria } from './rubric.js';

describe('PLAYBOOKS', () => {
  it.each(TASK_TYPES)('should give %s ordered steps, verification and a valid default rubric', (type) => {
    const playbook = PLAYBOOKS[type];
    expect(playbook.type).toBe(type);
    expect(playbook.steps.length).toBeGreaterThan(0);
    expect(playbook.verification.length).toBeGreaterThan(0);
    expect(parseRubricCriteria(playbook.rubric)).toEqual(playbook.rubric);
  });

  it('should make a bugfix reproduce with a failing test first', () => {
    expect(PLAYBOOKS.bugfix.steps[0]).toMatch(/^Reproduce the bug first: write a test that fails/);
  });

  it('should know only the five task types', () => {
    expect(TASK_TYPES.filter(isTaskType)).toEqual(['bugfix', 'feature', 'refactor', 'perf', 'prototype']);
    expect(isTaskType('bug-fix')).toBe(false);
  });
});

describe('classifyTask', () => {
  it.each([
    ['fix the crash when the config file is empty', 'bugfix', 'fix'],
    ['the retry test is flaky', 'bugfix', 'flaky'],
    ['refactor the auth module into smaller files', 'refactor', 'refactor'],
    ['make the search endpoint faster', 'perf', 'faster'],
    ['fix the slow query on the dashboard', 'perf', 'slow'],
    ['prototype two caching strategies', 'prototype', 'prototype'],
  ] as const)('should classify "%s" as %s', (task, type, keyword) => {
    expect(classifyTask(task)).toEqual({ type, source: 'classifier', reason: `the task mentions "${keyword}"` });
  });

  it('should default to feature when no keyword matches, and say so', () => {
    expect(classifyTask('add input validation to sum with a test')).toEqual({
      type: 'feature',
      source: 'classifier',
      reason: 'no keyword matched, feature is the default',
    });
  });

  it('should match whole words only', () => {
    expect(classifyTask('add a prefix option to the logger').type).toBe('feature');
  });
});
