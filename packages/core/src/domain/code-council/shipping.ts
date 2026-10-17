/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { agentFamily, familyKey } from '../agent/providers.js';
import { ROLE_KEYWORDS, specAgent } from '../roles/roles.js';
import type { SurvivalCell } from '../verification/adversarial.js';
import type { StepResult } from '../verification/gates.js';
import { blockingDissent, warningDissent, type Dissent } from './dissent.js';
import type { Synthesis } from './synthesis.js';

/** The verifier's report, written to the run directory. */
export const VERIFICATION_REPORT = 'verification.md';

/** The pull request body, written to the run directory; the `pr` gate's command reads it. */
export const PR_BODY = 'pr-body.md';

/** Where the decision trail is committed. A shipped commit never touches it. */
export const TRAIL_PATH_PREFIX = '.concilium/runs/';

/**
 * C8 "green is not safe". `PASS+NOTES`: nothing failed, but a gate that also fails on the base or the review left
 * notes. `BLOCKED`: no verdict could be reached, for instance no agent CLI is usable at all.
 */
export type PrVerdictStatus = 'PASS' | 'PASS+NOTES' | 'FAIL' | 'BLOCKED';

export type PrReview = { status: 'PASS' | 'NOTES' | 'FAIL'; text: string };

/**
 * The CLI that verified. `sameFamily`: no usable CLI was outside the author families, so one of them (or one of an
 * unknown family) verified; the verdict says so everywhere and the PR is always a draft.
 */
export type Verifier = {
  provider: string;
  model: string | null;
  /** Set by `--role verifier=`, `factory.yaml` or saved config, rather than picked. */
  configured: boolean;
} & ({ sameFamily: false; family: string } | { sameFamily: true; family: string | null; sameFamilyReason: string });

/** Where a run ships from: its integration branch, or the branch of its only candidate. */
export type ShipSource = { kind: 'integration' | 'candidate'; branch: string; authorFamilies: string[] };

/** An independent verdict on the commit a PR would ship, keyed to it, its base and its patch-id. */
export type PrVerdict = {
  verdict: PrVerdictStatus;
  reason: string;
  notes: string[];
  verifier: Verifier | null;
  /** The families of the base candidate, of every graft's donor and of every graft's integrator; or of the only candidate. */
  authorFamilies: string[];
  /** The branch it ships from (`ShipSource`), or null when there is none. */
  branch: string | null;
  /** The branch's head when it was verified. A new commit on the branch voids the verdict. */
  branchHead: string | null;
  /**
   * The commit verified, and the only one `concilium pr` pushes: the branch head, or its parent when the head is the
   * trail commit. Null when nothing may be pushed.
   */
  headSha: string | null;
  /** The trail commit left out of `headSha`, or null. */
  trailSha: string | null;
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
  /** The remote branch the verified commit is pushed to: `concilium/<run-id>`. */
  remoteBranch: string;
  /** The verified commit the push gate pushes, whatever the branch holds by then. */
  sha: string;
  /** The PR's base branch, or null for the remote's default branch. */
  base: string | null;
  title: string;
  bodyPath: string;
  /** Why the PR is opened as a draft (`draftReason`), or null when it is not. */
  draftReason: string | null;
  pushGate: string;
  prGate: string;
  requestedAt: string;
};

/** Who wrote the integration commits: the base candidate, and each committed graft's donor and integrator. */
export function authorFamilies(synthesis: Synthesis, candidates: { candidateId: string; provider: string; model?: string | null }[]): string[] {
  const familyOf = (id: string) => {
    const c = candidates.find((c) => c.candidateId === id);
    return c ? familyKey(c.provider, c.model) : id;
  };
  const families = [
    ...(synthesis.base ? [familyOf(synthesis.base.candidateId)] : []),
    ...synthesis.grafts.filter((g) => g.commitSha).flatMap((g) => [familyOf(g.candidateId), familyKey(g.integrator.provider, g.integrator.model)]),
  ];
  return [...new Set(families)];
}

/**
 * The integration branch when there is one; else, for a run with a single candidate, that candidate's branch, written
 * by its family alone. Otherwise there is nothing to ship.
 */
export function shipSource(record: {
  synthesis?: Synthesis;
  candidates: { candidateId: string; provider: string; model?: string | null; branch: string; headSha: string | null }[];
}): ShipSource | { blocked: string } {
  if (record.synthesis?.branch) {
    return { kind: 'integration', branch: record.synthesis.branch, authorFamilies: authorFamilies(record.synthesis, record.candidates) };
  }
  if (record.candidates.length !== 1) return { blocked: 'the run has no integration branch' };
  const only = record.candidates[0];
  if (!only.headSha) return { blocked: `the only candidate, ${only.candidateId}, has no head` };
  return { kind: 'candidate', branch: only.branch, authorFamilies: [familyKey(only.provider, only.model)] };
}

/** A path of the decision trail, which a shipped commit must not touch. */
export function isTrailPath(path: string): boolean {
  return path.startsWith(TRAIL_PATH_PREFIX);
}

/**
 * The verifier, preferring a family outside `authors`: the configured one (`cli[:model]`, or `auto`/null for none)
 * when its CLI is usable and outside them, else the first usable CLI of a known family outside them. With none, the
 * configured one or the first usable CLI, flagged `sameFamily`. Null only when no CLI is usable. The notes say why a
 * configured verifier was passed over.
 */
export function pickVerifier(
  authors: string[],
  usable: { provider: string; family: string | null }[],
  configured: string | null = null,
): { verifier: Verifier | null; notes: string[] } {
  const spec = configured && configured !== ROLE_KEYWORDS.verifier ? specAgent(configured) : null;
  const mine = spec && usable.some((u) => u.provider === spec.provider) ? { provider: spec.provider, family: agentFamily(spec.provider, spec.model) } : undefined;
  const outside = (u: { family: string | null }): u is { provider: string; family: string } => u.family !== null && !authors.includes(u.family);
  const notes: string[] = [];
  if (mine && outside(mine)) {
    return { verifier: { provider: mine.provider, model: spec!.model ?? null, configured: true, sameFamily: false, family: mine.family }, notes };
  }
  if (spec && !mine) notes.push(`the configured verifier ${configured} is not installed and signed in`);
  const other = usable.find(outside);
  if (other) {
    if (mine) notes.push(`the configured verifier ${configured} is of an author family (${mine.family ?? 'unknown'}); ${other.provider} verifies instead`);
    return { verifier: { provider: other.provider, model: null, configured: false, sameFamily: false, family: other.family }, notes };
  }
  const fallback = mine ?? usable[0];
  if (!fallback) return { verifier: null, notes };
  const sameFamilyReason =
    `no installed, signed-in CLI outside the author families (${authors.join(', ')}); ${fallback.provider} (${fallback.family ?? 'unknown family'}) verified`;
  return {
    verifier: { provider: fallback.provider, model: fallback === mine ? spec!.model ?? null : null, configured: fallback === mine, sameFamily: true, family: fallback.family, sameFamilyReason },
    notes,
  };
}

/** `cli[:model]` of a verifier, for the gateway. */
export function verifierSpec(v: Verifier): string {
  return v.model ? `${v.provider}:${v.model}` : v.provider;
}

function verifierLabel(v: Verifier | null): string {
  if (!v) return 'no verifier';
  return `${verifierSpec(v)} (${v.family ?? 'unknown family'})${v.sameFamily ? ', SAME FAMILY as the authors' : ''}`;
}

/** Why a PR from this verdict is a draft, or null: a verdict that is not a pass, or a same-family verifier. */
export function draftReason(v: PrVerdict): string | null {
  const reasons = [
    ...(v.verdict === 'PASS' || v.verdict === 'PASS+NOTES' ? [] : [`the verdict is ${v.verdict}`]),
    ...(v.verifier?.sameFamily ? ['the verifier is of an author family'] : []),
  ];
  return reasons.length ? reasons.join('; ') : null;
}

/** The warning every report of a same-family verdict carries, or null. */
export function sameFamilyWarning(v: PrVerdict): string | null {
  return v.verifier?.sameFamily ? `same-family verification: ${v.verifier.sameFamilyReason}. The pull request is a draft.` : null;
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

/**
 * A verdict holds only for what it verified: the local branch at another head than `branchHead`, or a remote head
 * known locally other than the shipped `headSha`, voids it.
 */
export function verdictState(verdict: PrVerdict, heads: { local: string | null; remote: string | null }): { valid: boolean; reason: string } {
  const at = verdict.headSha?.slice(0, 12) ?? 'no head';
  if (!verdict.headSha) return { valid: false, reason: 'the verdict has no commit to ship' };
  if (heads.local !== verdict.branchHead) {
    return {
      valid: false,
      reason: `void: ${verdict.branch} is at ${heads.local?.slice(0, 12) ?? 'nothing'}, the verdict is for ${verdict.branchHead?.slice(0, 12) ?? 'nothing'}; run verify-pr again`,
    };
  }
  if (heads.remote !== null && heads.remote !== verdict.headSha) {
    return { valid: false, reason: `void: the pushed branch is at ${heads.remote.slice(0, 12)}, the verdict is for ${at}; run verify-pr again` };
  }
  return { valid: true, reason: `for commit ${at}` };
}

/** `verification.md`: the verdict, what it is keyed to, who verified and what ran. */
export function verificationMarkdown(v: PrVerdict, run: { id: string; task: string }): string {
  const warning = sameFamilyWarning(v);
  const lines = [
    `# Verification of run ${run.id}`,
    '',
    `Task: ${run.task}`,
    '',
    `## Verdict: ${v.verdict}`,
    '',
    v.reason,
    ...(warning ? ['', `**Warning: ${warning}**`] : []),
    '',
    `- branch: ${v.branch ?? 'none'} at ${v.branchHead ?? 'nothing'}`,
    `- head: ${v.headSha ?? 'none'} (the commit verified and pushed)`,
    ...(v.trailSha ? [`- trail commit left out: ${v.trailSha}`] : []),
    `- base: ${v.baseSha}`,
    `- patch-id: ${v.patchId ?? 'none'}`,
    `- verifier: ${verifierLabel(v.verifier)}`,
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

/**
 * The PR body: the verdict, `synthesis.md`, a dissent summary and a pointer to the decision trail, which stays out
 * of the pull request.
 */
export function prBody(input: { runId: string; synthesisMd: string | null; dissent: Dissent[]; verdict: PrVerdict; trailDir: string }): string {
  const { verdict: v } = input;
  const open = input.dissent.filter((d) => d.resolution === 'open');
  const warning = sameFamilyWarning(v);
  const lines = [
    `Concilium run \`${input.runId}\`.`,
    '',
    `**Verdict: ${v.verdict}** at \`${v.headSha ?? 'none'}\` (base \`${v.baseSha}\`, patch-id \`${v.patchId ?? 'none'}\`) by ${verifierLabel(v.verifier)}: ${v.reason}`,
    ...(warning ? ['', `> **Warning: ${warning}**`] : []),
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
    v.trailSha
      ? `\`${input.trailDir}/decisions.tsv\`, \`dissent.json\` and \`synthesis.md\` are in commit \`${v.trailSha}\` on \`${v.branch}\`, left out of this pull request, and in the run directory.`
      : 'In the run directory; not part of this pull request.',
  ];
  if (input.synthesisMd) lines.push('', '---', '', input.synthesisMd.trim());
  return `${lines.join('\n')}\n`;
}
