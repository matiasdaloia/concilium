/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import type { AdversarialTest, SurvivalMatrix, TestValidity } from '../verification/adversarial.js';
import type { Judgment } from './judging.js';
import {
  completeQuestions,
  detectDivergence,
  parseReframeAnswer,
  reframeMarkdown,
  reframePrompt,
  type DivergenceCandidate,
  type Reframe,
} from './reframe.js';

const LINE = "slugify('Hello World') joins the words with a separator";

const claude: DivergenceCandidate = { candidateId: 'claude', family: 'anthropic', contends: true, newFailures: [] };
const codex: DivergenceCandidate = { candidateId: 'codex', family: 'openai', contends: true, newFailures: [] };

function test(id: string, author: string, validity: TestValidity, specClause = LINE): AdversarialTest {
  return { id, author, validity, files: [`${id}.test.js`], specClause };
}

function judgment(judge: string, totals: Record<string, number>): Judgment {
  return { status: 'PASS', candidates: Object.keys(totals), judge, sameFamily: false, sameFamilyReason: null, rubricSha256: 'x', scores: [], totals, reason: '' };
}

/** Two readings of one line: each family's test passes only on its own candidate. */
const AMBIGUOUS = {
  tests: [test('anthropic-1', 'anthropic', 'own-family-only'), test('openai-1', 'openai', 'own-family-only')],
  matrix: {
    'anthropic-1': { base: 'fail', claude: 'pass', codex: 'fail' },
    'openai-1': { base: 'fail', claude: 'fail', codex: 'pass' },
  } as SurvivalMatrix,
};

describe('detectDivergence', () => {
  it('should find disjoint survival when each candidate fails the other reading of the same line, and name that line', () => {
    expect(detectDivergence({ candidates: [claude, codex], ...AMBIGUOUS, judgments: [] })).toEqual([{
      trigger: 'disjoint-survival',
      detail: 'each candidate that passes the gates fails different adversarial tests: claude fails openai-1; codex fails anthropic-1',
      conflicts: [{ clause: LINE, evidence: ['claude passes anthropic-1, fails openai-1', 'codex passes openai-1, fails anthropic-1'] }],
    }]);
  });

  it('should find no divergence when one candidate fails nothing, or two fail the same test', () => {
    const dominated = { ...AMBIGUOUS, matrix: { ...AMBIGUOUS.matrix, 'openai-1': { base: 'fail', claude: 'pass', codex: 'pass' } } as SurvivalMatrix };
    expect(detectDivergence({ candidates: [claude, codex], ...dominated, judgments: [] })).toEqual([]);

    const gemini: DivergenceCandidate = { candidateId: 'gemini', family: 'google', contends: true, newFailures: [] };
    const shared = {
      tests: [test('google-1', 'google', 'evidence'), test('anthropic-1', 'anthropic', 'evidence')],
      matrix: { 'google-1': { claude: 'fail', codex: 'fail', gemini: 'pass' }, 'anthropic-1': { claude: 'pass', codex: 'pass', gemini: 'fail' } } as SurvivalMatrix,
    };
    expect(detectDivergence({ candidates: [claude, codex, gemini], ...shared, judgments: [] })).toEqual([]);
  });

  it('should ignore quarantined, vacuous and unrunnable tests, and a candidate\'s own family\'s tests', () => {
    for (const validity of ['quarantined', 'vacuous', 'unrunnable'] as const) {
      const tests = AMBIGUOUS.tests.map((t) => ({ ...t, validity }));
      expect(detectDivergence({ candidates: [claude, codex], tests, matrix: AMBIGUOUS.matrix, judgments: [] })).toEqual([]);
    }
    // claude fails its own family's test: that does not count against it, so it fails nothing.
    const own = { tests: [test('anthropic-1', 'anthropic', 'evidence'), test('openai-1', 'openai', 'evidence')], matrix: {
      'anthropic-1': { claude: 'fail', codex: 'fail' }, 'openai-1': { claude: 'pass', codex: 'pass' },
    } as SurvivalMatrix };
    expect(detectDivergence({ candidates: [claude, codex], ...own, judgments: [] })).toEqual([]);
  });

  it('should find no-gate-pass when every contender has a new gate failure, and stop there', () => {
    const failing = [{ ...claude, newFailures: ['test'] }, { ...codex, newFailures: ['test', 'lint'] }];
    expect(detectDivergence({ candidates: failing, ...AMBIGUOUS, judgments: [] })).toEqual([{
      trigger: 'no-gate-pass',
      detail: 'no candidate passes the gates: claude fails test; codex fails test, lint',
      conflicts: [
        { clause: 'gate test', evidence: ['claude fails it', 'codex fails it'] },
        { clause: 'gate lint', evidence: ['claude passes it', 'codex fails it'] },
      ],
    }]);
    // One passes: no no-gate-pass, and a single passer cannot diverge.
    expect(detectDivergence({ candidates: [failing[0], codex], ...AMBIGUOUS, judgments: [] })).toEqual([]);
  });

  it('should need two contenders: blocked and disqualified candidates do not count', () => {
    const out = { ...codex, contends: false };
    expect(detectDivergence({ candidates: [claude, out], ...AMBIGUOUS, judgments: [] })).toEqual([]);
    expect(detectDivergence({ candidates: [{ ...claude, newFailures: ['test'] }, { ...out, newFailures: ['test'] }], tests: [], matrix: {}, judgments: [] })).toEqual([]);
  });

  it('should find a judge spread when judges of the same tie pick different bases, and not for one judge or a shared top', () => {
    const a = judgment('gemini', { claude: 50, codex: 30 });
    const b = judgment('opencode', { claude: 20, codex: 40 });
    expect(detectDivergence({ candidates: [claude, codex], tests: [], matrix: {}, judgments: [a, b] })).toEqual([{
      trigger: 'judge-spread',
      detail: 'the judges pick different bases: gemini picks claude; opencode picks codex',
      conflicts: [{ clause: 'the base pick', evidence: ['gemini picks claude', 'opencode picks codex'] }],
    }]);
    expect(detectDivergence({ candidates: [claude, codex], tests: [], matrix: {}, judgments: [a] })).toEqual([]);
    expect(detectDivergence({ candidates: [claude, codex], tests: [], matrix: {}, judgments: [a, judgment('opencode', { claude: 9, codex: 9 })] })).toEqual([]);
    expect(detectDivergence({ candidates: [claude, codex], tests: [], matrix: {}, judgments: [a, { ...b, status: 'BLOCKED' }] })).toEqual([]);
  });
});

describe('reframe questions', () => {
  const [divergence] = detectDivergence({ candidates: [claude, codex], ...AMBIGUOUS, judgments: [] });

  it('should put the task, the divergence, each line in conflict and the diffs in the prompt, and ask for JSON', () => {
    const prompt = reframePrompt('Add slugify.', [divergence], [{ candidateId: 'claude', diff: '+hyphen' }, { candidateId: 'codex', diff: '+underscore' }]);
    expect(prompt.startsWith('You are phrasing spec questions')).toBe(true);
    expect(prompt).toContain('Task:\nAdd slugify.');
    expect(prompt).toContain(`- clause: ${LINE}\n  - claude passes anthropic-1, fails openai-1`);
    expect(prompt).toContain('## Candidate codex\nDiff against the project before any change:\n```diff\n+underscore\n```');
    expect(prompt).toContain('{"questions": [{"clause": "<a line in conflict>", "question": "<one question>"}]}');
  });

  it('should keep questions about a line in conflict and drop the rest by name', () => {
    const answer = '```json\n' + JSON.stringify({ questions: [
      { clause: LINE, question: 'Hyphen or underscore?' },
      { clause: 'something else', question: 'Why?' },
      { clause: LINE, question: ' ' },
    ] }) + '\n```';
    expect(parseReframeAnswer(answer, [LINE])).toEqual({
      questions: [{ clause: LINE, question: 'Hyphen or underscore?' }],
      notes: ['questions[1] dropped: names no line in conflict', 'questions[2] dropped: has no question'],
    });
    expect(() => parseReframeAnswer('no idea', [LINE])).toThrow('the question answer holds no JSON');
    expect(() => parseReframeAnswer('{"q": []}', [LINE])).toThrow('the question answer has no "questions" list');
  });

  it('should write a question from the evidence for every line the phraser left out', () => {
    const gates = detectDivergence({ candidates: [{ ...claude, newFailures: ['test'] }, { ...codex, newFailures: ['test'] }], tests: [], matrix: {}, judgments: [] });
    expect(completeQuestions([divergence, ...gates], [{ clause: LINE, question: 'Hyphen or underscore?' }])).toEqual([
      { clause: LINE, question: 'Hyphen or underscore?' },
      { clause: 'gate test', question: 'No candidate passes gate test (claude fails it; codex fails it). Does the task ask for something gate test rejects, or does it leave out a requirement the gate checks?' },
    ]);
    expect(completeQuestions([divergence], [])).toEqual([{
      clause: LINE,
      question: `The candidates read "${LINE}" differently (claude passes anthropic-1, fails openai-1; codex passes openai-1, fails anthropic-1). Which reading is intended? Restate the line so only one reading is left.`,
    }]);
  });

  it('should render reframe.md with the divergence, the lines in conflict and the numbered questions', () => {
    const reframe: Reframe = {
      divergence: [divergence], questions: [{ clause: LINE, question: 'Hyphen or underscore?' }], phraser: 'claude', source: 'phraser', notes: ['a note'], reportPath: null,
    };
    const md = reframeMarkdown(reframe, { id: 'r1', task: 'Add slugify.', baseSha: 'abcdef1234567890' });
    expect(md).toContain('# Reframe needed for run r1');
    expect(md).toContain('No patch was written');
    expect(md).toContain(`- disjoint-survival: ${divergence.detail}\n  - \`${LINE}\`: claude passes anthropic-1, fails openai-1; codex passes openai-1, fails anthropic-1`);
    expect(md).toContain('Phrased by `claude` from the evidence.');
    expect(md).toContain(`1. On "${LINE}": Hyphen or underscore?`);
    expect(md).toContain('## Notes\n\n- a note');
    expect(reframeMarkdown({ ...reframe, source: 'fallback' }, { id: 'r1', task: 't', baseSha: 'abc' })).toContain('Written from the evidence, without a phraser\'s answer.');
  });
});
