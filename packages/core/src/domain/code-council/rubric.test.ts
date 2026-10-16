/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { PLAYBOOKS } from './playbooks.js';
import {
  freezeRubric,
  parseRubricAnswer,
  parseRubricCriteria,
  rubricHash,
  rubricPrompt,
  RubricValidationError,
  type RubricCriterion,
} from './rubric.js';

const criterion = (name: string): RubricCriterion => ({ name, description: `${name} holds`, weight: 1, evidence: 'judgment' });
const three = [criterion('a'), criterion('b'), criterion('c')];

function problems(value: unknown): string[] {
  try {
    parseRubricCriteria(value);
  } catch (err) {
    if (err instanceof RubricValidationError) return err.problems;
    throw err;
  }
  return [];
}

describe('parseRubricCriteria', () => {
  it('should accept 3 to 6 criteria', () => {
    expect(parseRubricCriteria(three)).toEqual(three);
    expect(parseRubricCriteria([...three, criterion('d'), criterion('e'), criterion('f')])).toHaveLength(6);
  });

  it('should reject 2 or 7 criteria', () => {
    expect(problems(three.slice(0, 2))).toEqual(['criteria: must hold 3 to 6 criteria, got 2']);
    expect(problems([...three, ...'defg'.split('').map(criterion)])).toEqual(['criteria: must hold 3 to 6 criteria, got 7']);
  });

  it('should name every bad field at once', () => {
    expect(problems([criterion('a'), criterion('a'), { name: '', description: ' ', weight: 0, evidence: 'vibes' }])).toEqual([
      'criteria[1].name: "a" is used twice',
      'criteria[2].name: must be a non-empty string',
      'criteria[2].description: must be a non-empty string',
      'criteria[2].weight: must be a positive number',
      'criteria[2].evidence: must be one of gate, adversarial, judgment',
    ]);
    expect(problems({ criteria: three })).toEqual(['criteria: must be an array']);
  });

  it('should drop fields it does not know', () => {
    expect(parseRubricCriteria(three.map((c) => ({ ...c, extra: true })))).toEqual(three);
  });
});

describe('freezeRubric', () => {
  it('should stamp the time and a hash that changes when any criterion changes', () => {
    const frozen = freezeRubric(three, { source: 'playbook' }, new Date('2026-10-16T12:00:00Z'));
    expect(frozen).toMatchObject({ criteria: three, source: 'playbook', frozenAt: '2026-10-16T12:00:00.000Z' });
    expect(frozen.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(frozen.sha256).toBe(rubricHash(three));
    expect(rubricHash([{ ...three[0], weight: 2 }, three[1], three[2]])).not.toBe(frozen.sha256);
  });

  it('should refuse an invalid rubric', () => {
    expect(() => freezeRubric(three.slice(0, 2), { source: 'playbook' })).toThrow(RubricValidationError);
  });
});

describe('rubricPrompt', () => {
  it('should hold the task, the type and its default criteria, and ask for JSON only', () => {
    const prompt = rubricPrompt('fix the crash on empty config', PLAYBOOKS.bugfix);
    expect(prompt).toContain('Task:\nfix the crash on empty config');
    expect(prompt).toContain('bugfix task');
    expect(prompt).toContain(JSON.stringify(PLAYBOOKS.bugfix.rubric, null, 2));
    expect(prompt).toContain('Reply with only a JSON object: {"criteria": [...]}');
  });
});

describe('parseRubricAnswer', () => {
  it('should read a bare object, a fenced block or a bare array', () => {
    expect(parseRubricAnswer(JSON.stringify({ criteria: three }))).toEqual(three);
    expect(parseRubricAnswer(`Here it is:\n\`\`\`json\n${JSON.stringify({ criteria: three })}\n\`\`\`\nDone.`)).toEqual(three);
    expect(parseRubricAnswer(`Criteria: ${JSON.stringify(three)}`)).toEqual(three);
  });

  it('should reject an answer with no JSON, broken JSON or a bad rubric', () => {
    expect(() => parseRubricAnswer('I cannot help with that')).toThrow('answer: holds no JSON');
    expect(() => parseRubricAnswer('{"criteria": [')).toThrow(RubricValidationError);
    expect(() => parseRubricAnswer(JSON.stringify({ criteria: three.slice(0, 2) }))).toThrow('got 2');
  });
});
