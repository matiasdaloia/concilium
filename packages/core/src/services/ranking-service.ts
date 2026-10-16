/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { PROVIDER_IDS, getProviderInfo } from '../domain/agent/providers.js';
import { missingPlaybookSteps } from '../domain/code-council/framing.js';
import { judgePrompt, parseJudgeAnswer, pickJudge, type JudgePack, type Judgment } from '../domain/code-council/judging.js';
import { PLAYBOOKS, type TaskType } from '../domain/code-council/playbooks.js';
import { contends, rankCandidates, tieGroups, type CandidateReport, type EvidenceKey, type RankInput, type Ranking, type ReportEvidence } from '../domain/code-council/ranking.js';
import { rubricHash, type FrozenRubric } from '../domain/code-council/rubric.js';
import type { Survival } from '../domain/verification/adversarial.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import { CliCouncilGateway } from '../adapters/cli/cli-council-gateway.js';
import { GateRunner } from '../adapters/gate-runner.js';
import { createLogger } from '../shared/logger.js';
import type { AdversarialRound } from './adversarial-service.js';
import type { CodeCandidate } from './code-service.js';

const log = createLogger('ranking');

/** A judge sees at most this much of each diff. */
export const JUDGE_DIFF_LIMIT = 40_000;

/** The report and the ranking key of one candidate, from the evidence on the record. */
export function reportCandidate(candidate: CodeCandidate, ctx: { baseSha: string; type: TaskType; adversarial?: AdversarialRound }): { report: CandidateReport; key: EvidenceKey } {
  const v = candidate.verification;
  const head = candidate.headSha ?? undefined;
  const evidence: ReportEvidence[] = [{
    kind: 'agent',
    ok: candidate.status === 'ok',
    detail: candidate.status === 'ok' ? 'the agent finished' : `the agent ended with ${candidate.status}${candidate.errors[0] ? `: ${candidate.errors[0].split('\n')[0]}` : ''}`,
  }];

  if (v === undefined) evidence.push({ kind: 'gate', ok: false, detail: 'not verified: the gates did not run' });
  else if (v !== null) {
    if (v.gates.length === 0 && v.errors.length === 0) evidence.push({ kind: 'gate', ok: true, detail: 'no gates found', ...(v.sha ? { sha: v.sha } : {}) });
    if (v.install && v.install.outcome !== 'pass') evidence.push({ kind: 'gate', ok: false, detail: `install (${v.install.command}): ${v.install.outcome}`, sha: v.install.sha });
    for (const g of v.gates) {
      const detail = `${g.name}: ${g.outcome}${g.verdict === 'baseline-failure' ? ', fails on the base too' : g.verdict === 'new-failure' ? ', passes on the base' : ''}`;
      evidence.push({ kind: 'gate', ok: g.verdict !== 'new-failure', detail, sha: g.sha });
    }
    for (const error of v.errors) evidence.push({ kind: 'gate', ok: false, detail: error });
    for (const f of v.integrity) evidence.push({ kind: 'integrity', ok: false, detail: `${f.severity}: ${f.message}`, ...(head ? { sha: head } : {}) });
  }

  const survival: Survival | undefined = ctx.adversarial?.survival[candidate.candidateId];
  if (survival) {
    const failed = survival.failed.length ? `, failed ${survival.failed.join(', ')}` : '';
    evidence.push({ kind: 'survival', ok: survival.failed.length === 0, detail: `survived ${survival.survived}/${survival.counted} adversarial tests by other families${failed}` });
  }

  const missing = missingPlaybookSteps(candidate.finalText, PLAYBOOKS[ctx.type].steps.length);
  evidence.push({
    kind: 'playbook',
    ok: missing.length === 0,
    detail: missing.length ? `the final message does not list playbook step ${missing.join(', ')} as done or skipped` : 'every playbook step listed as done or skipped',
  });

  const key: EvidenceKey = {
    disqualified: v?.disqualified ?? false,
    newFailures: v?.newFailures.length ?? 0,
    survived: survival?.survived ?? 0,
    counted: survival?.counted ?? 0,
    penalties: v?.penalties ?? 0,
  };
  const base = { branch: candidate.branch, baseSha: ctx.baseSha, headSha: candidate.headSha, evidence };
  if (!candidate.headSha) return { key, report: { ...base, status: 'BLOCKED', reason: `no branch head: ${candidate.errors[0]?.split('\n')[0] ?? 'the worktree or commit failed'}` } };
  if (candidate.diffStat?.filesChanged === 0) return { key, report: { ...base, status: 'BLOCKED', reason: 'made no change' } };
  const issues = evidence.filter((e) => !e.ok);
  if (issues.length > 0) return { key, report: { ...base, status: 'ISSUES', reason: `${v?.disqualified ? 'disqualified; ' : ''}${issues.map((e) => e.detail).join('; ')}` } };
  return { key, report: { ...base, status: 'PASS', reason: 'every check passed' } };
}

/** The registered CLIs, in registry order, that are installed and not signed out, with their model family. */
async function usableClis(drivers: ReadonlyMap<string, HeadlessCliDriver>): Promise<{ provider: string; family: string | null }[]> {
  const found = await Promise.all(PROVIDER_IDS.map(async (provider) => {
    const d = await drivers.get(provider)?.detect().catch(() => undefined);
    return d?.installed && d.auth !== 'none' ? { provider, family: getProviderInfo(provider)?.family ?? null } : null;
  }));
  return found.filter((u) => u !== null);
}

export type JudgeTieInput = {
  task: string;
  repoDir: string;
  baseSha: string;
  rubric: FrozenRubric;
  /** The tied candidates, each with its report. */
  tied: { candidate: CodeCandidate; report: CandidateReport }[];
  drivers: ReadonlyMap<string, HeadlessCliDriver>;
  runner?: GateRunner;
  signal?: AbortSignal;
};

/**
 * Tier 3 for one tie group: checks the rubric still matches its frozen hash, picks a judge CLI from a family that
 * wrote none of the tied candidates, and has it score each one blind on every criterion, read-only.
 */
export async function judgeTie(input: JudgeTieInput): Promise<Judgment> {
  const judgment: Judgment = {
    status: 'BLOCKED', candidates: input.tied.map((t) => t.candidate.candidateId), judge: null, sameFamily: false, sameFamilyReason: null,
    rubricSha256: input.rubric.sha256, scores: [], totals: {}, reason: '',
  };
  const blocked = (reason: string): Judgment => {
    log.warn(`judge on ${judgment.candidates.join(', ')}: BLOCKED, ${reason}`);
    return { ...judgment, reason };
  };

  const actual = rubricHash(input.rubric.criteria);
  if (actual !== input.rubric.sha256) {
    return blocked(`the rubric does not match its frozen sha256 ${input.rubric.sha256.slice(0, 12)} (its criteria hash to ${actual.slice(0, 12)})`);
  }

  const families = [...new Set(input.tied.map((t) => getProviderInfo(t.candidate.provider)?.family ?? t.candidate.provider))];
  const choice = pickJudge(families, await usableClis(input.drivers));
  if (!choice) return blocked('no agent CLI is installed and signed in to judge');
  judgment.judge = choice.provider;
  judgment.sameFamily = choice.sameFamily;
  judgment.sameFamilyReason = choice.sameFamilyReason;
  if (choice.sameFamily) log.warn(`judge on ${judgment.candidates.join(', ')}: same family, ${choice.sameFamilyReason}`);

  const runner = input.runner ?? new GateRunner();
  const labels = input.tied.map((_, i) => String.fromCharCode(65 + i));
  const packs: JudgePack[] = await Promise.all(input.tied.map(async ({ candidate, report }, i) => {
    const diff = await runner.diff(input.repoDir, input.baseSha, candidate.headSha!);
    return {
      label: labels[i],
      diff: diff.length > JUDGE_DIFF_LIMIT ? `${diff.slice(0, JUDGE_DIFF_LIMIT)}\n... (diff truncated at ${JUDGE_DIFF_LIMIT} characters)` : diff,
      // The agent line can name the CLI, so the judge never gets it.
      evidence: report.evidence.filter((e) => e.kind !== 'agent').map((e) => `${e.ok ? 'ok' : 'issue'}, ${e.kind}: ${e.detail}`),
    };
  }));

  const gateway = new CliCouncilGateway({ drivers: input.drivers });
  const prompt = judgePrompt(input.task, input.rubric, packs);
  const response = await gateway.query(choice.provider, [{ role: 'user', content: prompt }], undefined, input.signal);
  if (!response) return blocked(`${choice.provider} gave no answer`);
  const criteria = input.rubric.criteria;
  try {
    const parsed = parseJudgeAnswer(response.content, labels, criteria.map((c) => c.name));
    judgment.scores = parsed.map((s) => ({ candidateId: judgment.candidates[labels.indexOf(s.label)], criterion: s.criterion, score: s.score, reason: s.reason }));
  } catch (err) {
    return blocked(`the answer from ${choice.provider} was rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const id of judgment.candidates) {
    judgment.totals[id] = judgment.scores
      .filter((s) => s.candidateId === id)
      .reduce((sum, s) => sum + s.score * criteria.find((c) => c.name === s.criterion)!.weight, 0);
  }
  log.info(`judge ${choice.provider} on ${judgment.candidates.join(', ')}: ${JSON.stringify(judgment.totals)}`);
  return { ...judgment, status: 'PASS', reason: `scored ${labels.length} candidates on ${criteria.length} criteria` };
}

export type RankRunInput = Omit<JudgeTieInput, 'tied'> & {
  type: TaskType;
  candidates: CodeCandidate[];
  adversarial?: AdversarialRound;
  /** Send exact ties among candidates that can win to a judge. Without it, ties stay tied. */
  judge: boolean;
  onJudgeDone?: (judgment: Judgment) => void;
};

/** Writes each candidate's report and ranks them: evidence first, a judge only for exact ties. */
export async function rankRun(input: RankRunInput): Promise<Ranking> {
  const entries: RankInput[] = input.candidates.map((candidate) => {
    const { report, key } = reportCandidate(candidate, { baseSha: input.baseSha, type: input.type, adversarial: input.adversarial });
    candidate.report = report;
    return { candidateId: candidate.candidateId, status: report.status, key };
  });

  const judgments: Judgment[] = [];
  if (input.judge) {
    for (const group of tieGroups(entries).filter((g) => g.length > 1 && contends(g[0]))) {
      const tied = group.map((e) => {
        const candidate = input.candidates.find((c) => c.candidateId === e.candidateId)!;
        return { candidate, report: candidate.report! };
      });
      const judgment = await judgeTie({ ...input, tied });
      judgments.push(judgment);
      if (judgment.sameFamily) {
        for (const { report } of tied) report.evidence.push({ kind: 'judge', ok: true, detail: `same-family judge: ${judgment.sameFamilyReason}` });
      }
      input.onJudgeDone?.(judgment);
    }
  }
  return rankCandidates(entries, judgments);
}
