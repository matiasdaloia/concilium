/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { getProviderInfo } from '../agent/providers.js';
import type { SurvivalCell } from '../verification/adversarial.js';
import type { StepResult } from '../verification/gates.js';
import { blockingDissent, warningDissent, type Dissent } from './dissent.js';
import type { Synthesis } from './synthesis.js';

/** The verifier's report, written to the run directory. */
export const VERIFICATION_REPORT = 'verification.md';

/** The pull request body, written to the run directory; the `pr` gate's command reads it. */
export const PR_BODY = 'pr-body.md';

/**
 * C8 "green is not safe". `PASS+NOTES`: nothing failed, but a gate that also fails on the base or the review left
 * notes. `BLOCKED`: no verdict could be reached, for instance no CLI outside the author families is usable.
 */
export type PrVerdictStatus = 'PASS' | 'PASS+NOTES' | 'FAIL' | 'BLOCKED';

export type PrReview = { status: 'PASS' | 'NOTES' | 'FAIL'; text: string };

/** An independent verdict on the integration branch, keyed to its head, its base and its patch-id. */
export type PrVerdict = {
  verdict: PrVerdictStatus;
  reason: string;
  notes: string[];
  /** The CLI that verified, of a family that wrote none of the integration commits. */
  verifier: { provider: string; family: string } | null;
  /** The families of the base candidate, of every graft's donor and of every graft's integrator. */
  authorFamilies: string[];
  branch: string;
  headSha: string | null;
  baseSha: string;
  /** `git patch-id --stable` of `baseSha..headSha`. */
  patchId: string | null;
  /** The gates and the valid adversarial tests, re-run in a fresh worktree at `headSha`. */
  gates: Record<string, StepResult['outcome']>;
  tests: Record<string, SurvivalCell>;
  /** The verifier CLI's read-only review of the diff. */
  review: PrReview | null;
  verifiedAt: string;
  reportPath: string | null;
};

/** The pull request asked for: its two paused gates, the pushed branch and the body file. */
export type PrRequest = {
  remote: string;
  /** The branch the integration branch is pushed to: `concilium/<run-id>`. */
  remoteBranch: string;
  /** The PR's base branch, or null for the remote's default branch. */
  base: string | null;
  title: string;
  bodyPath: string;
  /** Opened as a draft: the verdict was neither PASS nor PASS+NOTES. */
  draft: boolean;
  pushGate: string;
  prGate: string;
  requestedAt: string;
};

function familyOf(provider: string): string {
  return getProviderInfo(provider)?.family ?? provider;
}

/** Who wrote the integration commits: the base candidate, and each committed graft's donor and integrator. */
export function authorFamilies(synthesis: Synthesis, candidates: { candidateId: string; provider: string }[]): string[] {
  const providerOf = (id: string) => candidates.find((c) => c.candidateId === id)?.provider ?? id;
  const providers = [
    ...(synthesis.base ? [providerOf(synthesis.base.candidateId)] : []),
    ...synthesis.grafts.filter((g) => g.commitSha).flatMap((g) => [providerOf(g.candidateId), g.integrator.provider]),
  ];
  return [...new Set(providers.map(familyOf))];
}

/**
 * The first usable CLI of a known family outside `authors`. Unlike the judge, never a same-family fallback:
 * null means the verdict is BLOCKED.
 */
export function pickVerifier(authors: string[], usable: { provider: string; family: string | null }[]): { provider: string; family: string } | null {
  const other = usable.find((u) => u.family !== null && !authors.includes(u.family));
  return other ? { provider: other.provider, family: other.family! } : null;
}

/** The read-only review: the task, the gate results and the diff, and one verdict line first. */
export function reviewPrompt(task: string, diff: string, checks: string[]): string {
  return [
    'You are reviewing a change before it becomes a pull request. You did not write it.',
    'Read the diff against the task. Look for bugs, missing parts of the task, weakened tests and unrelated changes.',
    '',
    'Answer with one first line, exactly one of:',
    'VERDICT: PASS (nothing to change)',
    'VERDICT: NOTES (it can ship, with the notes below)',
    'VERDICT: FAIL (it must not ship as it is)',
    'Then your notes, one per line.',
    '',
    `Task: ${task}`,
    '',
    'Checks re-run at the head:',
    ...(checks.length ? checks.map((c) => `- ${c}`) : ['- none']),
    '',
    '```diff',
    diff.trimEnd(),
    '```',
  ].join('\n');
}

/** The first `VERDICT:` line of a review, or null when there is none. */
export function parseReview(text: string): PrReview | null {
  const match = /^\W*VERDICT:\W*(PASS|NOTES|FAIL)\b/im.exec(text);
  return match ? { status: match[1].toUpperCase() as PrReview['status'], text: text.trim() } : null;
}

/**
 * FAIL when a gate that passes on the base does not pass at the head, a valid adversarial test does not pass, or
 * the review says FAIL. BLOCKED when the review gave no verdict. PASS+NOTES when a gate fails on the base too or the
 * review has notes. PASS otherwise.
 */
export function decideVerdict(input: {
  headSha: string;
  baseline: Record<string, StepResult['outcome']>;
  gates: Record<string, StepResult['outcome']>;
  tests: Record<string, SurvivalCell>;
  review: PrReview | null;
}): { verdict: PrVerdictStatus; reason: string; notes: string[] } {
  const at = input.headSha.slice(0, 12);
  const failures: string[] = [];
  const notes: string[] = [];
  for (const [name, outcome] of Object.entries(input.gates)) {
    if (outcome === 'pass') continue;
    if (input.baseline[name] === 'pass' || input.baseline[name] === undefined) failures.push(`gate ${name} is ${outcome} at ${at}`);
    else notes.push(`gate ${name} is ${outcome} at ${at} and on the base`);
  }
  for (const [id, cell] of Object.entries(input.tests)) {
    if (cell !== 'pass') failures.push(`adversarial test ${id} is ${cell} at ${at}`);
  }
  if (input.review?.status === 'FAIL') failures.push('the review says FAIL');
  if (failures.length > 0) return { verdict: 'FAIL', reason: failures.join('; '), notes };
  if (!input.review) return { verdict: 'BLOCKED', reason: 'the review gave no VERDICT line', notes };
  if (input.review.status === 'NOTES') notes.push('the review has notes');
  return notes.length > 0
    ? { verdict: 'PASS+NOTES', reason: `nothing failed at ${at}; ${notes.join('; ')}`, notes }
    : { verdict: 'PASS', reason: `every gate and valid adversarial test passes at ${at} and the review says PASS`, notes };
}

/** A verdict holds only for the head it verified: a newer local head, or a remote head known locally, voids it. */
export function verdictState(verdict: PrVerdict, heads: { local: string | null; remote: string | null }): { valid: boolean; reason: string } {
  const at = verdict.headSha?.slice(0, 12) ?? 'no head';
  if (!verdict.headSha) return { valid: false, reason: 'the verdict has no head' };
  if (heads.local !== verdict.headSha) {
    return { valid: false, reason: `void: ${verdict.branch} is at ${heads.local?.slice(0, 12) ?? 'nothing'}, the verdict is for ${at}; run verify-pr again` };
  }
  if (heads.remote !== null && heads.remote !== verdict.headSha) {
    return { valid: false, reason: `void: the pushed branch is at ${heads.remote.slice(0, 12)}, the verdict is for ${at}; run verify-pr again` };
  }
  return { valid: true, reason: `for head ${at}` };
}

/** `verification.md`: the verdict, what it is keyed to, who verified and what ran. */
export function verificationMarkdown(v: PrVerdict, run: { id: string; task: string }): string {
  const lines = [
    `# Verification of run ${run.id}`,
    '',
    `Task: ${run.task}`,
    '',
    `## Verdict: ${v.verdict}`,
    '',
    v.reason,
    '',
    `- branch: ${v.branch}`,
    `- head: ${v.headSha ?? 'none'}`,
    `- base: ${v.baseSha}`,
    `- patch-id: ${v.patchId ?? 'none'}`,
    `- verifier: ${v.verifier ? `${v.verifier.provider} (${v.verifier.family})` : 'none'}`,
    `- author families: ${v.authorFamilies.join(', ') || 'none'}`,
    `- verified: ${v.verifiedAt}`,
    '',
    'A new commit on the branch voids this verdict.',
    '',
    '## Gates',
    '',
    ...(Object.keys(v.gates).length ? Object.entries(v.gates).map(([name, outcome]) => `- ${name}: ${outcome}`) : ['- none ran']),
    '',
    '## Adversarial tests',
    '',
    ...(Object.keys(v.tests).length ? Object.entries(v.tests).map(([id, cell]) => `- ${id}: ${cell}`) : ['- none']),
  ];
  if (v.notes.length) lines.push('', '## Notes', '', ...v.notes.map((n) => `- ${n}`));
  if (v.review) lines.push('', `## Review (${v.review.status})`, '', v.review.text);
  return `${lines.join('\n')}\n`;
}

/** The PR title: the task's first line, at most 72 characters. */
export function prTitle(task: string): string {
  const line = task.trim().split('\n')[0].trim();
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

/** The PR body: the verdict, `synthesis.md`, a dissent summary and pointers to the decision trail. */
export function prBody(input: {
  runId: string;
  synthesisMd: string | null;
  dissent: Dissent[];
  verdict: PrVerdict;
  trail: { commitSha: string | null; dir: string } | null;
}): string {
  const { verdict: v } = input;
  const open = input.dissent.filter((d) => d.resolution === 'open');
  const lines = [
    `Concilium run \`${input.runId}\`.`,
    '',
    `**Verdict: ${v.verdict}** at \`${v.headSha ?? 'none'}\` (base \`${v.baseSha}\`, patch-id \`${v.patchId ?? 'none'}\`) by ${v.verifier ? `${v.verifier.provider} (${v.verifier.family})` : 'no verifier'}: ${v.reason}`,
    '',
    'A commit after that head voids the verdict. Merging is manual.',
    '',
    '## Dissent',
    '',
    `${input.dissent.length} records: ${open.length} open (${blockingDissent(input.dissent).length} blocking), ${warningDissent(input.dissent).length} warnings.`,
    ...open.map((d) => `- open ${d.id} (${d.source}): ${d.summary}`),
    '',
    '## Decision trail',
    '',
    input.trail?.commitSha
      ? `\`${input.trail.dir}/decisions.tsv\`, \`dissent.json\` and \`synthesis.md\` in commit \`${input.trail.commitSha}\`.`
      : 'Not committed on the branch.',
  ];
  if (input.synthesisMd) lines.push('', '---', '', input.synthesisMd.trim());
  return `${lines.join('\n')}\n`;
}
