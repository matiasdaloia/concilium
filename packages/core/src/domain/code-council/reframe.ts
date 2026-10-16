/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { AdversarialTest, SurvivalMatrix } from '../verification/adversarial.js';
import type { Judgment } from './judging.js';
import { jsonFromAnswer } from './rubric.js';

/** The reframe report, written to the run directory instead of `result.patch`. */
export const REFRAME_REPORT = 'reframe.md';

/**
 * Why the candidates diverge (B7.6), checked among those that can win (not blocked, not disqualified):
 * - `no-gate-pass`: none of them passes the gates (each has a new gate failure).
 * - `disjoint-survival`: of those passing the gates, each fails at least one adversarial test another family wrote
 *   and another candidate passes, and no two fail the same one, so none dominates.
 * - `judge-spread`: judges of the same tie pick different bases.
 */
export type DivergenceTrigger = 'no-gate-pass' | 'disjoint-survival' | 'judge-spread';

/** One line the candidates split on (a task clause, a gate, or the base pick), with what each candidate did. */
export type Conflict = { clause: string; evidence: string[] };

export type Divergence = { trigger: DivergenceTrigger; detail: string; conflicts: Conflict[] };

/** A question for whoever wrote the task, about one line in conflict. */
export type SpecQuestion = { clause: string; question: string };

/** M5.2: the run ends in `reframe-needed` with the questions the divergence exposed, and no patch. */
export type Reframe = {
  divergence: Divergence[];
  questions: SpecQuestion[];
  /** The CLI that phrased the questions, read-only; null when none was asked. */
  phraser: string | null;
  /** `fallback`: the questions were written from the evidence, without the phraser's answer. */
  source: 'phraser' | 'fallback';
  notes: string[];
  reportPath: string | null;
};

export type DivergenceCandidate = {
  candidateId: string;
  family: string;
  /** Not blocked and not disqualified. */
  contends: boolean;
  /** Gates that fail on it and pass on the base. */
  newFailures: string[];
};

/** Tests some candidate can pass that fail on the base, or pass there for a feature: the ones a split can show in. */
function satisfiable(tests: AdversarialTest[]): AdversarialTest[] {
  return tests.filter((t) => t.validity === 'evidence' || t.validity === 'own-family-only' || t.validity === 'regression-guard');
}

/** The top of one judgment, or null when its best total is shared. */
function pick(j: Judgment): string | null {
  const best = Math.max(...j.candidates.map((id) => j.totals[id] ?? 0));
  const top = j.candidates.filter((id) => (j.totals[id] ?? 0) === best);
  return top.length === 1 ? top[0] : null;
}

/**
 * Divergence among the candidates that can win, or none. It needs at least 2 of them. A run where none passes the
 * gates stops at `no-gate-pass`; otherwise the survival and the judges are checked.
 */
export function detectDivergence(input: { candidates: DivergenceCandidate[]; tests: AdversarialTest[]; matrix: SurvivalMatrix; judgments: Judgment[] }): Divergence[] {
  const contenders = input.candidates.filter((c) => c.contends);
  if (contenders.length < 2) return [];

  const passers = contenders.filter((c) => c.newFailures.length === 0);
  if (passers.length === 0) {
    const gates = [...new Set(contenders.flatMap((c) => c.newFailures))];
    return [{
      trigger: 'no-gate-pass',
      detail: `no candidate passes the gates: ${contenders.map((c) => `${c.candidateId} fails ${c.newFailures.join(', ')}`).join('; ')}`,
      conflicts: gates.map((gate) => ({ clause: `gate ${gate}`, evidence: contenders.map((c) => `${c.candidateId} ${c.newFailures.includes(gate) ? 'fails' : 'passes'} it`) })),
    }];
  }

  const found: Divergence[] = [];
  const tests = satisfiable(input.tests);
  const cell = (t: AdversarialTest, id: string) => input.matrix[t.id]?.[id] ?? 'error';
  // An author's own tests carry no weight for its family, here as in survival.
  const failed = passers.map((c) => tests.filter((t) => t.author !== c.family && cell(t, c.candidateId) !== 'pass'));
  const disjoint = failed.every((f, i) => f.length > 0 && failed.slice(i + 1).every((other) => !other.some((t) => f.includes(t))));
  if (passers.length >= 2 && disjoint) {
    const clauses = [...new Set(failed.flat().map((t) => t.specClause))];
    found.push({
      trigger: 'disjoint-survival',
      detail: `each candidate that passes the gates fails different adversarial tests: ${passers.map((c, i) => `${c.candidateId} fails ${failed[i].map((t) => t.id).join(', ')}`).join('; ')}`,
      conflicts: clauses.map((clause) => {
        const about = tests.filter((t) => t.specClause === clause);
        return {
          clause,
          evidence: passers.map((c) => {
            const by = (outcome: 'pass' | 'fail') => about.filter((t) => (cell(t, c.candidateId) === 'pass') === (outcome === 'pass')).map((t) => t.id);
            const parts = [by('pass').length ? `passes ${by('pass').join(', ')}` : '', by('fail').length ? `fails ${by('fail').join(', ')}` : ''];
            return `${c.candidateId} ${parts.filter(Boolean).join(', ')}`;
          }),
        };
      }),
    });
  }

  const groups = new Map<string, Judgment[]>();
  for (const j of input.judgments.filter((j) => j.status === 'PASS')) {
    const key = [...j.candidates].sort().join('\n');
    groups.set(key, [...(groups.get(key) ?? []), j]);
  }
  for (const judgments of groups.values()) {
    const picks = judgments.map((j) => ({ judge: j.judge ?? 'a judge', pick: pick(j) })).filter((p) => p.pick !== null);
    if (new Set(picks.map((p) => p.pick)).size < 2) continue;
    const evidence = picks.map((p) => `${p.judge} picks ${p.pick}`);
    found.push({ trigger: 'judge-spread', detail: `the judges pick different bases: ${evidence.join('; ')}`, conflicts: [{ clause: 'the base pick', evidence }] });
  }
  return found;
}

/** What the phraser sees of one candidate: its id and its diff against the base. */
export type ReframePack = { candidateId: string; diff: string };

/** The prompt that asks a read-only CLI to turn the divergence into questions about the task. */
export function reframePrompt(task: string, divergence: Divergence[], packs: ReframePack[]): string {
  return [
    'You are phrasing spec questions. Agents wrote candidate solutions to the coding task below, and the evidence shows they diverge, so the task can be read more than one way.',
    'For each line in conflict, write one concrete question for the person who wrote the task, whose answer settles which reading is intended. Point at what the candidates did differently.',
    'Do not pick a reading yourself, and do not propose a blend.',
    '',
    `Task:\n${task}`,
    '',
    '## Divergence',
    ...divergence.flatMap((d) => [
      '',
      `${d.trigger}: ${d.detail}`,
      'Lines in conflict:',
      ...d.conflicts.flatMap((c) => [`- clause: ${c.clause}`, ...c.evidence.map((e) => `  - ${e}`)]),
    ]),
    ...packs.flatMap((p) => ['', `## Candidate ${p.candidateId}`, 'Diff against the project before any change:', '```diff', p.diff.trimEnd(), '```']),
    '',
    'Do not change any files. Reply with only a JSON object, with each clause copied exactly as listed after "clause:":',
    '{"questions": [{"clause": "<a line in conflict>", "question": "<one question>"}]}',
  ].join('\n');
}

/**
 * Reads the phraser's answer. Entries whose clause is not one of `clauses`, or with no question, are dropped with a
 * note. Throws when the answer holds no JSON or no `questions` list.
 */
export function parseReframeAnswer(text: string, clauses: string[]): { questions: SpecQuestion[]; notes: string[] } {
  let parsed: unknown;
  try {
    parsed = jsonFromAnswer(text);
  } catch (err) {
    throw new Error(`the question answer ${(err as Error).message}`);
  }
  const entries = (parsed as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(entries)) throw new Error('the question answer has no "questions" list');

  const questions: SpecQuestion[] = [];
  const notes: string[] = [];
  entries.forEach((entry: unknown, i) => {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const clause = typeof e.clause === 'string' ? e.clause.trim() : '';
    const question = typeof e.question === 'string' ? e.question.trim() : '';
    const problem = !clauses.includes(clause) ? 'names no line in conflict' : !question ? 'has no question' : null;
    if (problem) notes.push(`questions[${i}] dropped: ${problem}`);
    else questions.push({ clause, question });
  });
  return { questions, notes };
}

/** The question written from the evidence alone, for a line the phraser left out. */
export function fallbackQuestion(trigger: DivergenceTrigger, conflict: Conflict): SpecQuestion {
  const evidence = conflict.evidence.join('; ');
  const question = trigger === 'no-gate-pass'
    ? `No candidate passes ${conflict.clause} (${evidence}). Does the task ask for something ${conflict.clause} rejects, or does it leave out a requirement the gate checks?`
    : trigger === 'disjoint-survival'
      ? `The candidates read "${conflict.clause}" differently (${evidence}). Which reading is intended? Restate the line so only one reading is left.`
      : `The judges pick different bases (${evidence}). Which trade-off between the candidates does the task want?`;
  return { clause: conflict.clause, question };
}

/** One question per line in conflict: the phraser's when it gave one, the fallback otherwise. */
export function completeQuestions(divergence: Divergence[], phrased: SpecQuestion[]): SpecQuestion[] {
  const questions: SpecQuestion[] = [];
  for (const d of divergence) {
    for (const c of d.conflicts) {
      if (questions.some((q) => q.clause === c.clause)) continue;
      const mine = phrased.filter((q) => q.clause === c.clause);
      questions.push(...(mine.length ? mine : [fallbackQuestion(d.trigger, c)]));
    }
  }
  return questions;
}

/** `reframe.md`: why the run stopped, the lines in conflict with their evidence, and the questions. */
export function reframeMarkdown(r: Reframe, run: { id: string; task: string; baseSha: string }): string {
  const lines = [
    `# Reframe needed for run ${run.id}`, '', `Task: ${run.task}`, '',
    `The candidates diverge from base \`${run.baseSha.slice(0, 12)}\`, so the task can be read more than one way. No patch was written: answer the questions, restate the task, and run again.`,
    '', '## Divergence', '',
  ];
  for (const d of r.divergence) {
    lines.push(`- ${d.trigger}: ${d.detail}`);
    for (const c of d.conflicts) lines.push(`  - \`${c.clause}\`: ${c.evidence.join('; ')}`);
  }
  lines.push('', '## Questions', '', r.source === 'phraser' ? `Phrased by \`${r.phraser}\` from the evidence.` : 'Written from the evidence, without a phraser\'s answer.', '');
  lines.push(...r.questions.map((q, i) => `${i + 1}. On "${q.clause}": ${q.question}`), '');
  if (r.notes.length) lines.push('## Notes', '', ...r.notes.map((n) => `- ${n}`), '');
  return lines.join('\n');
}
