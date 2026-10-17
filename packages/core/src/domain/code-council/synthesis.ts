/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { Brief } from '../driver/brief.js';
import type { ReportStatus } from '../driver/report.js';
import type { SurvivalCell } from '../verification/adversarial.js';
import type { StepResult } from '../verification/gates.js';
import type { PatchCheck } from '../../ports/workspace.js';
import { dissentMarkdown, type Dissent } from './dissent.js';
import type { JudgeChoice } from './judging.js';
import type { RankEntry, Ranking } from './ranking.js';
import { jsonFromAnswer } from './rubric.js';

/** At most this many grafts are taken from one losing candidate. */
export const MAX_GRAFTS_PER_CANDIDATE = 2;

/** The patch of the integration branch, written to the run directory. */
export const RESULT_PATCH = 'result.patch';

/** The synthesis report, written to the run directory. */
export const SYNTHESIS_REPORT = 'synthesis.md';

/** One idea from a losing candidate, with where it lives in that candidate's diff. */
export type GraftIdea = {
  candidateId: string;
  files: string[];
  /** A hunk header or excerpt of the source diff, when the picker named one. */
  hunk: string | null;
  instruction: string;
  why: string;
};

/** A fact behind a rejected graft. `output` is the end of the failing run's output. */
export type GraftEvidence = { kind: 'integrator' | 'gate' | 'test' | 'integrity'; detail: string; sha?: string; output?: string };

export type Graft = GraftIdea & {
  /** `graft-1`, `graft-2`, ... in the order they were applied. */
  id: string;
  status: 'applied' | 'rejected';
  /** The commit the integrator's change went in, or null when it changed nothing. */
  commitSha: string | null;
  /** The commit that reverted it, when it was rejected after being committed. */
  revertSha: string | null;
  /** Why it was rejected; empty when applied. */
  reason: string;
  evidence: GraftEvidence[];
  integrator: { provider: string; model: string | null; status: ReportStatus; durationMs: number; errors: string[]; finalText: string; brief: Brief | null };
};

/** The gates and valid adversarial tests at the integration head, at `sha`. */
export type SynthesisChecks = { sha: string; gates: Record<string, StepResult['outcome']>; tests: Record<string, SurvivalCell> };

/**
 * Synthesis tried before a reframe (M5.2): the candidates failed different adversarial tests (`disjoint-survival`),
 * and those tests were re-run at the integration head. Unresolved, no patch is kept and the run needs a reframe.
 */
export type SynthesisDivergence = { tests: string[]; resolved: boolean; reason: string };

/**
 * Whether the checks at the integration head settle a divergence: every gate that passes on the base passes there,
 * and so does every conflicting test.
 */
export function settleDivergence(checks: SynthesisChecks, tests: string[], baseline: Record<string, StepResult['outcome']>): SynthesisDivergence {
  const problems = [
    ...Object.entries(checks.gates).filter(([name, outcome]) => outcome !== 'pass' && (baseline[name] ?? 'pass') === 'pass').map(([name, outcome]) => `gate ${name} is ${outcome}`),
    ...tests.filter((id) => checks.tests[id] !== 'pass').map((id) => `${id} is ${checks.tests[id] ?? 'error'}`),
  ];
  return problems.length === 0
    ? { tests, resolved: true, reason: `the integration head passes the gates and every conflicting test (${tests.join(', ')})` }
    : { tests, resolved: false, reason: `at the integration head ${problems.join(', ')}` };
}

/** M5.1: the winner as the base, grafts from the losers folded in one commit each, re-verified, and the patch. */
export type Synthesis = {
  /** Why it did not run. */
  skipped?: string;
  base: { candidateId: string; headSha: string; reason: string } | null;
  /** `concilium/<run-id>/integration`. */
  branch: string | null;
  worktree: string | null;
  headSha: string | null;
  /** The CLI that named the grafts, read-only. */
  picker: JudgeChoice | null;
  notes: string[];
  grafts: Graft[];
  /** Candidates that could not give a graft: blocked or disqualified. */
  dropouts: { candidateId: string; reason: string }[];
  /** The checks at the integration head: what a graft was compared against. */
  checks: SynthesisChecks | null;
  patchPath: string | null;
  synthesisPath: string | null;
  /** The patch applies to the target repo's current `HEAD`. */
  mergeable: boolean;
  mergeCheck: PatchCheck | null;
  /** Why the patch is not labelled mergeable even when it applies: open dissent on an acceptance line. */
  mergeBlock?: string;
  /** Set when synthesis ran to settle a `disjoint-survival` divergence. */
  divergence?: SynthesisDivergence;
};

/** What the graft picker sees of one candidate: a label, its evidence and its diff against the run's base. */
export type GraftPack = { label: string; diff: string; evidence: string[] };

function section(title: string, pack: GraftPack): string[] {
  return [
    '',
    `## ${title}`,
    'Evidence:',
    ...(pack.evidence.length ? pack.evidence.map((e) => `- ${e}`) : ['- none']),
    'Diff against the project before any change:',
    '```diff',
    pack.diff.trimEnd(),
    '```',
  ];
}

/** The prompt that asks a read-only CLI for the ideas worth taking from the other candidates into the base. */
export function graftPrompt(task: string, base: GraftPack, others: GraftPack[]): string {
  return [
    `You are choosing grafts. Agents you do not know wrote ${others.length + 1} solutions to the coding task below. The Base won on the evidence and will ship.`,
    `Read each other candidate and name at most ${MAX_GRAFTS_PER_CANDIDATE} ideas from it that would make the Base better: an edge case it handles that the Base misses, a test, a cleaner helper.`,
    'Name only ideas the Base lacks. When the candidates agree, or a candidate has nothing better, name none for it.',
    'Each graft names its candidate, the files of that candidate\'s diff it comes from, optionally the hunk (its @@ header or a short excerpt), a short instruction for whoever folds it into the Base by hand, and why it helps.',
    '',
    `Task:\n${task}`,
    ...section('Base', base),
    ...others.flatMap((p) => section(`Candidate ${p.label}`, p)),
    '',
    'Do not change any files. Reply with only a JSON object:',
    '{"grafts": [{"candidate": "<candidate letter>", "files": ["<path in its diff>"], "hunk": "<optional>", "instruction": "<what to change in the Base>", "why": "<one line>"}]}',
  ].join('\n');
}

/**
 * Reads the picker's answer. Entries with an unknown candidate, a file outside that candidate's diff, or no
 * instruction or reason are dropped with a note, as are those past `MAX_GRAFTS_PER_CANDIDATE` for a candidate.
 * Throws when the answer holds no JSON or no `grafts` list.
 */
export function parseGraftAnswer(text: string, filesByLabel: Record<string, string[]>): { grafts: (Omit<GraftIdea, 'candidateId'> & { label: string })[]; notes: string[] } {
  let parsed: unknown;
  try {
    parsed = jsonFromAnswer(text);
  } catch (err) {
    throw new Error(`the graft answer ${(err as Error).message}`);
  }
  const entries = (parsed as { grafts?: unknown } | null)?.grafts;
  if (!Array.isArray(entries)) throw new Error('the graft answer has no "grafts" list');

  const labels = Object.keys(filesByLabel);
  const grafts: (Omit<GraftIdea, 'candidateId'> & { label: string })[] = [];
  const notes: string[] = [];
  entries.forEach((entry: unknown, i) => {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const label = typeof e.candidate === 'string' ? e.candidate.trim().replace(/^candidate\s+/i, '') : '';
    const files = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === 'string').map((f) => f.trim()).filter(Boolean) : [];
    const instruction = typeof e.instruction === 'string' ? e.instruction.trim() : '';
    const why = typeof e.why === 'string' ? e.why.trim() : '';
    const outside = labels.includes(label) ? files.find((f) => !filesByLabel[label].includes(f)) : undefined;
    const problem = !labels.includes(label) ? `candidate must be one of ${labels.join(', ')}`
      : files.length === 0 ? 'names no file'
      : outside ? `${outside} is not in candidate ${label}'s diff`
      : !instruction ? 'has no instruction'
      : !why ? 'has no reason'
      : grafts.filter((g) => g.label === label).length >= MAX_GRAFTS_PER_CANDIDATE ? `candidate ${label} already has ${MAX_GRAFTS_PER_CANDIDATE} grafts`
      : null;
    if (problem) {
      notes.push(`grafts[${i}] dropped: ${problem}`);
      return;
    }
    const hunk = typeof e.hunk === 'string' && e.hunk.trim() ? e.hunk.trim() : null;
    grafts.push({ label, files, hunk, instruction, why });
  });
  return { grafts, notes };
}

/** The write-mode brief of a fresh integrator: fold one graft by hand into the base in the integration worktree. */
export function integratorBrief(input: { task: string; graft: GraftIdea & { id: string }; worktree: string; branch: string; sourcePatch: string }): Brief {
  const { graft } = input;
  return {
    version: 1,
    task: [
      'You are integrating one idea from another solution into the solution in your directory, which solves the task below.',
      'Fold the idea in by hand so the result stays coherent. Do not copy the other solution wholesale, and change nothing the idea does not need.',
      '',
      `Task:\n${input.task}`,
      '',
      `Graft ${graft.id}:`,
      `Instruction: ${graft.instruction}`,
      `Why: ${graft.why}`,
      `Source files: ${graft.files.join(', ')}`,
      ...(graft.hunk ? [`Source hunk: ${graft.hunk}`] : []),
      '',
      'Keep the existing tests passing; never delete, skip or weaken a test to get there. When you finish, say in one line what you changed.',
    ].join('\n'),
    mode: 'code',
    cwd: input.worktree,
    constraints: [
      `You are in ${input.worktree}, a git worktree on branch ${input.branch}. Make every change inside this directory.`,
      'You do not need to commit: Concilium commits what you leave in the working tree. Do not push, and do not create or switch branches.',
      `Source solution diff, read-only: ${input.sourcePatch}`,
    ],
    allowedActions: ['read', 'write', 'shell'],
  };
}

function graftLine(g: Graft): string {
  return `**${g.id}** from \`${g.candidateId}\` (${g.files.map((f) => `\`${f}\``).join(', ')}${g.hunk ? `, hunk \`${g.hunk.split('\n')[0]}\`` : ''}): ${g.instruction} Why: ${g.why}`;
}

function survivalCell(e: RankEntry): string {
  return e.key.counted ? `${e.key.survived}/${e.key.counted}` : 'none counted';
}

/**
 * The `## Ranking` section of `synthesis.md`: one table row per candidate in rank order (tied candidates share a
 * rank), then the winner. The desktop's run viewer shows the same order, read from `run.json`.
 */
export function rankingMarkdown(ranking: Ranking): string[] {
  const rows = ranking.order.map((e) => {
    const report = `${e.status}${e.key.disqualified ? ', disqualified' : ''}`;
    const diff = `${e.size.lines} lines, ${e.size.files} files`;
    return `| ${e.rank} | \`${e.candidateId}\` | ${report} | ${e.key.newFailures} | ${survivalCell(e)} | ${e.key.penalties} | ${diff} | ${e.judgeTotal ?? '-'} |`;
  });
  return [
    '## Ranking', '',
    '| Rank | Candidate | Report | New gate failures | Survival | Penalties | Diff | Judge total |',
    '|---|---|---|---|---|---|---|---|',
    ...rows, '',
    ranking.winner ? `Winner: \`${ranking.winner}\`: ${ranking.reason}.` : `No winner: ${ranking.reason}.`, '',
  ];
}

/**
 * `synthesis.md`: the dissent (when given), the ranking (when given), the base, the applied grafts with their source,
 * the rejected ones with their evidence, the dropouts, the checks and the patch.
 */
export function synthesisMarkdown(s: Synthesis, run: { id: string; task: string; baseSha: string; ranking?: Ranking }, dissent?: Dissent[]): string {
  const lines = [
    `# Synthesis of run ${run.id}`, '', `Task: ${run.task}`, '',
    ...(dissent ? dissentMarkdown(dissent) : []),
    ...(run.ranking ? rankingMarkdown(run.ranking) : []),
  ];
  if (s.skipped) return [...lines, `Skipped: ${s.skipped}.`, ''].join('\n');

  const applied = s.grafts.filter((g) => g.status === 'applied');
  const rejected = s.grafts.filter((g) => g.status === 'rejected');
  if (s.divergence) {
    const d = s.divergence;
    lines.push('## Divergence', '', `The candidates diverged (disjoint-survival on ${d.tests.join(', ')}), so grafting was tried before a reframe.`, '');
    lines.push(d.resolved ? `Resolved: ${d.reason}.` : `Not resolved: ${d.reason}. No patch was kept: the run needs a reframe (see \`reframe.md\`).`, '');
  }
  lines.push('## Base', '', `\`${s.base!.candidateId}\` at \`${s.base!.headSha}\` (${s.base!.reason}).`, '');
  if (s.picker) lines.push(`Grafts named by \`${s.picker.provider}\`${s.picker.sameFamily ? `, a same-family picker: ${s.picker.sameFamilyReason}` : ''}.`, '');
  lines.push('## Applied grafts', '');
  lines.push(...(applied.length ? applied.map((g) => `- ${graftLine(g)} Commit \`${g.commitSha}\`.`) : ['None.']), '');
  lines.push('## Rejected grafts', '');
  if (rejected.length === 0) lines.push('None.');
  for (const g of rejected) {
    lines.push(`- ${graftLine(g)}`, `  Rejected: ${g.reason}.${g.revertSha ? ` Commit \`${g.commitSha}\`, reverted by \`${g.revertSha}\`.` : ''}`);
    for (const e of g.evidence) {
      lines.push(`  - ${e.kind}: ${e.detail}${e.sha ? ` at \`${e.sha}\`` : ''}`);
      if (e.output?.trim()) lines.push('    ```', ...e.output.trimEnd().split('\n').slice(-20).map((l) => `    ${l}`), '    ```');
    }
  }
  lines.push('', '## Dropouts', '');
  lines.push(...(s.dropouts.length ? s.dropouts.map((d) => `- \`${d.candidateId}\`: ${d.reason}`) : ['None.']), '');
  if (s.notes.length) lines.push('## Notes', '', ...s.notes.map((n) => `- ${n}`), '');
  if (s.checks) {
    lines.push('## Checks at the integration head', '', `At \`${s.checks.sha}\`:`, '');
    lines.push(...Object.entries(s.checks.gates).map(([name, outcome]) => `- gate ${name}: ${outcome}`));
    lines.push(...Object.entries(s.checks.tests).map(([id, cell]) => `- adversarial test ${id}: ${cell}`), '');
  }
  lines.push('## Result', '', `- Integration branch: \`${s.branch}\` at \`${s.headSha}\``);
  lines.push(s.divergence && !s.divergence.resolved
    ? '- Patch: none, the divergence is not resolved'
    : `- Patch: \`${s.patchPath ?? RESULT_PATCH}\` (\`${run.baseSha.slice(0, 12)}..${s.headSha?.slice(0, 12)}\`)`);
  const check = s.mergeCheck;
  const target = check?.target && check.target !== 'HEAD' ? check.target : '`HEAD`';
  lines.push(check
    ? `- Mergeable: ${s.mergeable ? 'yes' : 'no'}, ${s.mergeBlock ? `${s.mergeBlock}; ` : ''}\`git apply --check\` against ${target} at \`${check.targetSha}\`${check.applies ? '' : `: ${check.output.split('\n')[0]}`}`
    : `- Mergeable: no, ${s.mergeBlock ? `${s.mergeBlock}; ` : ''}the patch was not checked`);
  return [...lines, ''].join('\n');
}
