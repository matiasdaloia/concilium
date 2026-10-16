/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import type { AdversarialTest } from '../verification/adversarial.js';
import type { Judgment } from './judging.js';
import type { Ranking } from './ranking.js';
import type { Synthesis } from './synthesis.js';

/** The dissent records of a code run, written to the run directory. */
export const DISSENT_FILE = 'dissent.json';

/** Two judges' scores of one candidate on one criterion differ by more than this: a `rubric-spread` dissent. */
export const RUBRIC_SCORE_SPREAD = 3;

export type DissentSource = 'base-pick' | 'adversarial-test' | 'quarantined-test' | 'rejected-graft' | 'rubric-spread' | 'same-family-judge';

/** Where a dissent can be checked: a commit, an adversarial test, a file, a judgment, the frozen rubric. */
export type DissentEvidence = { kind: 'commit' | 'test' | 'file' | 'judgment' | 'rubric'; ref: string; sha?: string };

/** Why a quarantined test is a warning and not a block. */
export const QUARANTINED_REASON = 'quarantined: fails on base and every candidate; not classified by a judge';

/**
 * `open` has no reason yet; every other resolution says why, and `overruled` points at the evidence that overrules it.
 * A `warning` is shown with the run but never takes the "mergeable" label away.
 */
export type DissentResolution =
  | { resolution: 'open'; resolutionReason: null }
  | { resolution: 'accepted-risk' | 'overruled' | 'resolved' | 'warning'; resolutionReason: string };

type DissentBody = {
  source: DissentSource;
  summary: string;
  evidence: DissentEvidence[];
  /** The acceptance line of the task it is about, when it is about one. */
  acceptanceClause: string | null;
  /** For a `base-pick`: why the base was picked, and why the judge would pick another. */
  rationales?: { pick: string; dissent: string };
};

/** B8: a disagreement kept as output, with its id (`dissent-1`, ...). Open dissent on an acceptance line blocks the "mergeable" label. */
export type Dissent = { id: string } & DissentBody & DissentResolution;

export type DissentInput = {
  ranking: Ranking;
  /** Each candidate's branch head. */
  heads: Record<string, string | null>;
  tests: AdversarialTest[];
  synthesis?: Synthesis;
};

type Draft = DissentBody & DissentResolution;

function judgeName(j: Judgment): string {
  return j.judge ?? 'the judge';
}

function commit(ref: string, sha: string | null | undefined): DissentEvidence[] {
  return sha ? [{ kind: 'commit', ref, sha }] : [];
}

/** A `PASS` judgment over the winner whose top score goes to other candidates: it would have picked another base. */
function basePicks(input: DissentInput): Draft[] {
  const { ranking, heads } = input;
  const winner = ranking.winner;
  if (!winner) return [];
  const pick = ranking.order.find((e) => e.candidateId === winner)!;
  return ranking.judgments.flatMap((j): Draft[] => {
    if (j.status !== 'PASS' || !j.candidates.includes(winner)) return [];
    const best = Math.max(...j.candidates.map((c) => j.totals[c] ?? 0));
    const tops = j.candidates.filter((c) => (j.totals[c] ?? 0) === best);
    if (tops.includes(winner)) return [];
    const top = tops[0];
    const reasons = j.scores.filter((s) => s.candidateId === top).map((s) => `${s.criterion} ${s.score}: ${s.reason}`);
    return [{
      source: 'base-pick',
      summary: `${judgeName(j)} prefers ${top} as the base; the pick is ${winner}`,
      evidence: [
        { kind: 'judgment', ref: judgeName(j) }, { kind: 'rubric', ref: `sha256:${j.rubricSha256}` },
        ...commit(winner, heads[winner]), ...commit(top, heads[top]),
      ],
      acceptanceClause: null,
      rationales: {
        pick: `${winner}: ${ranking.reason}`,
        dissent: `${top} totals ${j.totals[top]} against ${j.totals[winner] ?? 0} for ${winner}; ${reasons.join('; ')}`,
      },
      resolution: 'overruled',
      resolutionReason: `the evidence ranks ${winner} first (${pick.key.newFailures} new gate failures, survival ${pick.key.counted ? `${pick.key.survived}/${pick.key.counted}` : 'none counted'}, `
        + `${pick.key.penalties} penalties) at ${heads[winner] ?? 'no head'}: ${ranking.reason}`,
    }];
  });
}

/** The tests checked at the integration head that it does not pass. */
function failingAtHead(input: DissentInput): Draft[] {
  const s = input.synthesis;
  if (!s?.checks) return [];
  const checks = s.checks;
  return Object.entries(checks.tests).filter(([, cell]) => cell !== 'pass').map(([id, cell]): Draft => {
    const test = input.tests.find((t) => t.id === id);
    return {
      source: 'adversarial-test',
      summary: `the integration head is ${cell} on adversarial test ${id}${test ? ` by ${test.author}` : ''}`,
      evidence: [{ kind: 'test', ref: id }, ...(test?.files ?? []).map((f): DissentEvidence => ({ kind: 'file', ref: f })), ...commit(s.branch ?? 'integration', checks.sha)],
      acceptanceClause: test?.specClause ?? null,
      resolution: 'open',
      resolutionReason: null,
    };
  });
}

/** Tests that fail on the base and on every candidate: a real gap or an invalid test, which no judge has decided yet. A warning. */
function quarantined(input: DissentInput): Draft[] {
  return input.tests.filter((t) => t.validity === 'quarantined').map((t): Draft => ({
    source: 'quarantined-test',
    summary: `adversarial test ${t.id} by ${t.author} fails on the base and on every candidate; no judge has said whether it is a real gap or an invalid test`,
    evidence: [{ kind: 'test', ref: t.id }, ...t.files.map((f): DissentEvidence => ({ kind: 'file', ref: f }))],
    acceptanceClause: t.specClause,
    resolution: 'warning',
    resolutionReason: QUARANTINED_REASON,
  }));
}

/** A rejected graft is overruled by the checks that failed after it; one the integrator never delivered stays open. */
function rejectedGrafts(input: DissentInput): Draft[] {
  return (input.synthesis?.grafts ?? []).filter((g) => g.status === 'rejected').map((g): Draft => {
    const checked = g.evidence.filter((e) => e.kind !== 'integrator');
    const base: DissentBody = {
      source: 'rejected-graft',
      summary: `${g.id} from ${g.candidateId} (${g.files.join(', ')}) was rejected: ${g.instruction}`,
      evidence: [
        ...commit(g.id, g.commitSha), ...commit(`revert of ${g.id}`, g.revertSha), ...commit(g.candidateId, input.heads[g.candidateId]),
        ...g.files.map((f): DissentEvidence => ({ kind: 'file', ref: f })),
      ],
      acceptanceClause: null,
    };
    if (checked.length === 0) return { ...base, summary: `${base.summary} (${g.reason})`, resolution: 'open', resolutionReason: null };
    return {
      ...base,
      resolution: 'overruled',
      resolutionReason: checked.map((e) => `${e.detail}${e.sha ? ` at ${e.sha}` : ''}`).join('; ') + (g.revertSha ? `; reverted by ${g.revertSha}` : ''),
    };
  });
}

/** Judgments of the same candidates whose scores of one candidate on one criterion differ by more than `RUBRIC_SCORE_SPREAD`. */
function rubricSpreads(input: DissentInput): Draft[] {
  const groups = new Map<string, Judgment[]>();
  for (const j of input.ranking.judgments.filter((j) => j.status === 'PASS')) {
    const key = [...j.candidates].sort().join(',');
    groups.set(key, [...(groups.get(key) ?? []), j]);
  }
  return [...groups.values()].filter((js) => js.length > 1).flatMap((js) => {
    const pairs = [...new Set(js.flatMap((j) => j.scores.map((s) => `${s.candidateId}\u0000${s.criterion}`)))];
    return pairs.flatMap((pair): Draft[] => {
      const [candidateId, criterion] = pair.split('\u0000');
      const scored = js.flatMap((j) => j.scores.filter((s) => s.candidateId === candidateId && s.criterion === criterion).map((s) => ({ j, s })));
      const values = scored.map(({ s }) => s.score);
      const spread = Math.max(...values) - Math.min(...values);
      if (spread <= RUBRIC_SCORE_SPREAD) return [];
      return [{
        source: 'rubric-spread',
        summary: `the judges score ${candidateId} on ${criterion} ${scored.map(({ j, s }) => `${s.score} (${judgeName(j)}: ${s.reason})`).join(', ')}, a spread of ${spread}`,
        evidence: [...scored.map(({ j }): DissentEvidence => ({ kind: 'judgment', ref: judgeName(j) })), { kind: 'rubric', ref: `sha256:${js[0].rubricSha256}` }],
        acceptanceClause: null,
        resolution: 'open',
        resolutionReason: null,
      }];
    });
  });
}

/** A same-family judge or graft picker is allowed only as a last resort: kept as an accepted risk with its reason. */
function sameFamily(input: DissentInput): Draft[] {
  const judges = input.ranking.judgments.filter((j) => j.sameFamily).map((j): Draft => ({
    source: 'same-family-judge',
    summary: `${judgeName(j)} judged ${j.candidates.join(', ')}, and is of one of their families`,
    evidence: [{ kind: 'judgment', ref: judgeName(j) }],
    acceptanceClause: null,
    resolution: 'accepted-risk',
    resolutionReason: j.sameFamilyReason ?? 'no reason was recorded',
  }));
  const picker = input.synthesis?.picker;
  if (!picker?.sameFamily) return judges;
  return [...judges, {
    source: 'same-family-judge',
    summary: `${picker.provider} named the grafts, and is of the base's or a donor's family`,
    evidence: [{ kind: 'judgment', ref: picker.provider }],
    acceptanceClause: null,
    resolution: 'accepted-risk',
    resolutionReason: picker.sameFamilyReason ?? 'no reason was recorded',
  }];
}

/** B8: every dissent the run's evidence holds, numbered in a fixed order of sources. */
export function collectDissent(input: DissentInput): Dissent[] {
  return [basePicks, failingAtHead, quarantined, rejectedGrafts, rubricSpreads, sameFamily]
    .flatMap((source) => source(input))
    .map((d, i) => ({ id: `dissent-${i + 1}`, ...d }));
}

/** Open dissent on an acceptance line: what keeps a patch from being labelled mergeable. */
export function blockingDissent(records: Dissent[]): Dissent[] {
  return records.filter((d) => d.resolution === 'open' && d.acceptanceClause !== null);
}

/** Dissent shown as a warning: it never blocks the "mergeable" label. */
export function warningDissent(records: Dissent[]): Dissent[] {
  return records.filter((d) => d.resolution === 'warning');
}

const RESOLUTION_LABEL = { 'accepted-risk': 'Accepted risk', overruled: 'Overruled', resolved: 'Resolved', warning: 'Warning' } as const;

/** The synthesis with its "mergeable" label taken away, and why, when open dissent concerns an acceptance line. */
export function withDissent(s: Synthesis, records: Dissent[]): Synthesis {
  const blocking = blockingDissent(records);
  if (s.skipped || blocking.length === 0) return s;
  return { ...s, mergeable: false, mergeBlock: `open dissent on acceptance lines: ${blocking.map((d) => `${d.id} ("${d.acceptanceClause}")`).join(', ')}` };
}

function dissentLines(d: Dissent): string[] {
  const lines = [`- **${d.id}** ${d.resolution}, ${d.source}: ${d.summary}.`];
  if (d.acceptanceClause) lines.push(`  Acceptance line: "${d.acceptanceClause}".`);
  if (d.rationales) lines.push(`  Pick: ${d.rationales.pick}.`, `  Dissent: ${d.rationales.dissent}.`);
  if (d.evidence.length) lines.push(`  Evidence: ${d.evidence.map((e) => `${e.kind} \`${e.ref}\`${e.sha ? ` at \`${e.sha}\`` : ''}`).join(', ')}.`);
  if (d.resolution !== 'open') lines.push(`  ${RESOLUTION_LABEL[d.resolution]}: ${d.resolutionReason}.`);
  return lines;
}

function warningSentence(warnings: Dissent[], blocking: boolean): string {
  if (warnings.length === 0) return '';
  const count = `${warnings.length} warning${warnings.length === 1 ? '' : 's'} (${warnings.map((d) => d.id).join(', ')})`;
  const verb = warnings.length === 1 ? 'does' : 'do';
  return blocking ? ` ${count} ${verb} not.` : ` ${count} ${verb} not keep the patch from being labelled mergeable.`;
}

/** The `## Dissent` section that opens `synthesis.md` and `reframe.md`: open records first, then warnings. */
export function dissentMarkdown(records: Dissent[]): string[] {
  const open = records.filter((d) => d.resolution === 'open');
  const warnings = warningDissent(records);
  const blocking = blockingDissent(records);
  const lines = ['## Dissent', ''];
  if (records.length === 0) return [...lines, 'None.', ''];
  lines.push(`${open.length} open of ${records.length}, also in \`${DISSENT_FILE}\`.${blocking.length ? ` Open dissent on an acceptance line (${blocking.map((d) => d.id).join(', ')}) keeps the patch from being labelled mergeable.` : ''}${warningSentence(warnings, blocking.length > 0)}`, '');
  const rest = records.filter((d) => d.resolution !== 'open' && d.resolution !== 'warning');
  for (const d of [...open, ...warnings, ...rest]) lines.push(...dissentLines(d));
  return [...lines, ''];
}
