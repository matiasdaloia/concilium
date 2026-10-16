/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

export const BRIEF_MODES = ['plan', 'code'] as const;
export type BriefMode = (typeof BRIEF_MODES)[number];

export const ALLOWED_ACTIONS = ['read', 'write', 'shell', 'network'] as const;
export type AllowedAction = (typeof ALLOWED_ACTIONS)[number];

/** What one headless CLI run is asked to do. Plain JSON, so it can be written to the run store as is. */
export type Brief = {
  version: 1;
  task: string;
  mode: BriefMode;
  /** The directory the agent works in (a worktree, never the user's checkout). */
  cwd: string;
  constraints: string[];
  allowedActions: AllowedAction[];
};

/** The prompt a CLI gets for a brief: the task, then its constraints as a list. */
export function briefPrompt(brief: Brief): string {
  if (brief.constraints.length === 0) return brief.task;
  return `${brief.task}\n\nConstraints:\n${brief.constraints.map((c) => `- ${c}`).join('\n')}`;
}

export class BriefValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid brief: ${problems.join('; ')}`);
    this.name = 'BriefValidationError';
  }
}

/** Checks an untrusted value (e.g. parsed JSON) and returns it as a `Brief`, or throws naming every bad field. */
export function parseBrief(value: unknown): Brief {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) throw new BriefValidationError(['brief: must be an object']);
  const b = value as Record<string, unknown>;

  if (b.version !== 1) problems.push('version: must be 1');
  if (typeof b.task !== 'string' || !b.task.trim()) problems.push('task: must be a non-empty string');
  if (!BRIEF_MODES.includes(b.mode as BriefMode)) problems.push(`mode: must be one of ${BRIEF_MODES.join(', ')}`);
  if (typeof b.cwd !== 'string' || !b.cwd.trim()) problems.push('cwd: must be a non-empty string');
  if (!Array.isArray(b.constraints) || !b.constraints.every((c) => typeof c === 'string')) {
    problems.push('constraints: must be an array of strings');
  }
  if (!Array.isArray(b.allowedActions) || !b.allowedActions.every((a) => ALLOWED_ACTIONS.includes(a as AllowedAction))) {
    problems.push(`allowedActions: must be an array of ${ALLOWED_ACTIONS.join(', ')}`);
  } else if (b.mode === 'plan' && b.allowedActions.includes('write')) {
    problems.push('allowedActions: a plan brief cannot allow write');
  }

  if (problems.length > 0) throw new BriefValidationError(problems);
  return {
    version: 1,
    task: b.task as string,
    mode: b.mode as BriefMode,
    cwd: b.cwd as string,
    constraints: b.constraints as string[],
    allowedActions: b.allowedActions as AllowedAction[],
  };
}
