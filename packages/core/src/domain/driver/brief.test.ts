/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { BriefValidationError, parseBrief, type Brief } from './brief.js';

const brief: Brief = {
  version: 1,
  task: 'Fix the off-by-one in paginate()',
  mode: 'code',
  cwd: '/tmp/worktree',
  constraints: ['Do not add dependencies'],
  allowedActions: ['read', 'write', 'shell'],
};

function problemsOf(value: unknown): string[] {
  try {
    parseBrief(value);
  } catch (err) {
    if (err instanceof BriefValidationError) return err.problems;
    throw err;
  }
  return [];
}

describe('parseBrief', () => {
  it('should accept a brief that went through JSON', () => {
    expect(parseBrief(JSON.parse(JSON.stringify(brief)))).toEqual(brief);
  });

  it('should name the missing task', () => {
    const { task: _task, ...noTask } = brief;
    expect(problemsOf(noTask)).toEqual(['task: must be a non-empty string']);
  });

  it('should name every bad field at once', () => {
    expect(problemsOf({ ...brief, version: 2, mode: 'review', cwd: ' ', constraints: 'none', allowedActions: ['sudo'] })).toEqual([
      'version: must be 1',
      'mode: must be one of plan, code',
      'cwd: must be a non-empty string',
      'constraints: must be an array of strings',
      'allowedActions: must be an array of read, write, shell, network',
    ]);
  });

  it('should refuse a plan brief that allows writes', () => {
    expect(problemsOf({ ...brief, mode: 'plan' })).toEqual(['allowedActions: a plan brief cannot allow write']);
  });

  it('should refuse a non-object', () => {
    expect(problemsOf('Fix it')).toEqual(['brief: must be an object']);
  });
});
