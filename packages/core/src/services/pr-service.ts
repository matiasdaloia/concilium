/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  authorFamilies,
  decideVerdict,
  parseReview,
  pickVerifier,
  PR_BODY,
  prBody,
  prTitle,
  reviewPrompt,
  VERIFICATION_REPORT,
  verdictState,
  verificationMarkdown,
  type PrRequest,
  type PrVerdict,
} from '../domain/code-council/shipping.js';
import { testGate, type SurvivalCell } from '../domain/verification/adversarial.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import { CliCouncilGateway } from '../adapters/cli/cli-council-gateway.js';
import { GateRunner } from '../adapters/gate-runner.js';
import { detachedWorktree, patchId, refHead } from '../adapters/git-worktree-workspace.js';
import { createLogger } from '../shared/logger.js';
import { ActionGate, ghPrCreateCommand, gitPushCommand, listGates, type GateEntry } from './action-gate.js';
import { runTestInLane } from './adversarial-service.js';
import type { CodeRunRecord } from './code-service.js';
import { JUDGE_DIFF_LIMIT, usableClis } from './ranking-service.js';
import { committedTrailDir } from './trail-service.js';

const log = createLogger('pr');

/** The branch the integration branch is pushed to. */
export function prBranch(runId: string): string {
  return `concilium/${runId}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type VerifyPrInput = {
  record: CodeRunRecord;
  /** Where `verification.md` is written. */
  runDir: string;
  drivers: ReadonlyMap<string, HeadlessCliDriver>;
  runner?: GateRunner;
  signal?: AbortSignal;
  onStep?: (line: string) => void;
};

/**
 * M7.2. A CLI of a family that wrote none of the integration commits re-runs the run's gates and its valid
 * adversarial suite in a fresh worktree at the integration head, then reviews the diff read-only. With no such CLI
 * the verdict is BLOCKED. The verdict is keyed to the head, the base and the patch-id, and written to `verification.md`.
 */
export async function verifyPr(input: VerifyPrInput): Promise<PrVerdict> {
  const { record } = input;
  const synthesis = record.synthesis;
  const branch = synthesis?.branch ?? prBranch(record.id);
  const verdict: PrVerdict = {
    verdict: 'BLOCKED', reason: '', notes: [], verifier: null, authorFamilies: [], branch, headSha: null, baseSha: record.baseSha,
    patchId: null, gates: {}, tests: {}, review: null, verifiedAt: new Date().toISOString(), reportPath: null,
  };
  const finish = async (): Promise<PrVerdict> => {
    await mkdir(input.runDir, { recursive: true });
    verdict.reportPath = join(input.runDir, VERIFICATION_REPORT);
    await writeFile(verdict.reportPath, verificationMarkdown(verdict, { id: record.id, task: record.task }));
    log.info(`run ${record.id}: ${verdict.verdict} at ${verdict.headSha ?? 'no head'} (${verdict.reason})`);
    return verdict;
  };

  if (!synthesis?.branch) {
    verdict.reason = 'the run has no integration branch';
    return finish();
  }
  verdict.headSha = await refHead(record.repoDir, `refs/heads/${branch}`);
  if (!verdict.headSha) {
    verdict.reason = `${branch} does not exist in ${record.repoDir}`;
    return finish();
  }
  verdict.patchId = await patchId(record.repoDir, record.baseSha, verdict.headSha);
  verdict.authorFamilies = authorFamilies(synthesis, record.candidates);
  verdict.verifier = pickVerifier(verdict.authorFamilies, await usableClis(input.drivers));
  if (!verdict.verifier) {
    verdict.reason = `no installed, signed-in CLI outside the author families (${verdict.authorFamilies.join(', ')}) can verify`;
    return finish();
  }
  if (!record.verification) {
    verdict.reason = 'the run has no gate plan to re-run';
    return finish();
  }
  input.onStep?.(`verifier: ${verdict.verifier.provider} (${verdict.verifier.family}), authors: ${verdict.authorFamilies.join(', ')}`);

  const runner = input.runner ?? new GateRunner();
  const plan = record.verification.plan;
  const lane = await detachedWorktree(record.repoDir, verdict.headSha);
  try {
    const result = await runner.runLane('verify', lane.path, plan, { signal: input.signal, onGate: (g) => input.onStep?.(`gate ${g.name}: ${g.outcome}`) });
    verdict.gates = Object.fromEntries(result.gates.map((g) => [g.name, g.outcome]));

    const gate = testGate(plan);
    const valid = (record.adversarial?.tests ?? []).filter((t) => t.validity === 'evidence' || t.validity === 'regression-guard');
    for (const t of valid) {
      const adversary = record.adversarial!.adversaries.find((a) => a.family === t.author);
      let cell: SurvivalCell = 'error';
      if (gate && verdict.gates[gate.name] === 'pass' && adversary?.headSha) {
        // The adversary's tests are read from its committed head, so they run even after gc removed its worktree.
        const from = await detachedWorktree(record.repoDir, adversary.headSha);
        try {
          const run = await runTestInLane(runner, gate, from.path, t.files, lane.path, verdict.headSha, input.signal);
          cell = run.outcome === 'pass' || run.outcome === 'fail' ? run.outcome : 'error';
        } finally {
          await from.remove();
        }
      }
      verdict.tests[t.id] = cell;
      input.onStep?.(`adversarial test ${t.id}: ${cell}`);
    }
  } finally {
    await lane.remove();
  }

  const diff = await runner.diff(record.repoDir, record.baseSha, verdict.headSha);
  const checks = [...Object.entries(verdict.gates).map(([n, o]) => `gate ${n}: ${o}`), ...Object.entries(verdict.tests).map(([id, c]) => `adversarial test ${id}: ${c}`)];
  const prompt = reviewPrompt(record.task, diff.length > JUDGE_DIFF_LIMIT ? `${diff.slice(0, JUDGE_DIFF_LIMIT)}\n... (diff truncated at ${JUDGE_DIFF_LIMIT} characters)` : diff, checks);
  try {
    const response = await new CliCouncilGateway({ drivers: input.drivers }).query(verdict.verifier.provider, [{ role: 'user', content: prompt }], undefined, input.signal);
    verdict.review = response ? parseReview(response.content) : null;
    if (!response) verdict.notes.push(`${verdict.verifier.provider} gave no review`);
  } catch (err) {
    verdict.notes.push(`the review failed: ${errorMessage(err)}`);
  }

  const baseline = Object.fromEntries((record.verification.baseline?.gates ?? []).map((g) => [g.name, g.outcome]));
  const decided = decideVerdict({ headSha: verdict.headSha, baseline, gates: verdict.gates, tests: verdict.tests, review: verdict.review });
  verdict.verdict = decided.verdict;
  verdict.reason = decided.reason;
  verdict.notes.push(...decided.notes);
  return finish();
}

export type RequestPrInput = {
  record: CodeRunRecord;
  runDir: string;
  verdict: PrVerdict;
  remote: string;
  /** The PR's base branch; without it, the remote's default branch. */
  base?: string;
  gate?: ActionGate;
};

/**
 * Writes `pr-body.md` and asks for two paused actions: push the integration branch (trail commit included) to
 * `concilium/<run-id>` on the remote, then open the PR from it. Nothing runs until each gate is approved. Unless the
 * verdict is PASS or PASS+NOTES, the PR is a draft.
 */
export async function requestPr(input: RequestPrInput): Promise<{ pr: PrRequest; gates: GateEntry[] }> {
  const { record } = input;
  const branch = record.synthesis?.branch;
  if (!branch) throw new Error(`run ${record.id} has no integration branch`);
  const synthesisMd = record.synthesis?.synthesisPath ? await readFile(record.synthesis.synthesisPath, 'utf8').catch(() => null) : null;
  const body = prBody({
    runId: record.id, synthesisMd, dissent: record.dissent.records, verdict: input.verdict,
    trail: record.trail ? { commitSha: record.trail.commitSha, dir: committedTrailDir(record.id) } : null,
  });
  await mkdir(input.runDir, { recursive: true });
  const bodyPath = join(input.runDir, PR_BODY);
  await writeFile(bodyPath, body);

  const remoteBranch = prBranch(record.id);
  const title = prTitle(record.task);
  const draft = input.verdict.verdict !== 'PASS' && input.verdict.verdict !== 'PASS+NOTES';
  const gate = input.gate ?? new ActionGate({ runId: record.id, runDir: input.runDir });
  const push = await gate.request({
    kind: 'push', command: gitPushCommand(input.remote, `refs/heads/${branch}:refs/heads/${remoteBranch}`), cwd: record.repoDir,
    reason: `push ${branch} (verdict ${input.verdict.verdict} at ${input.verdict.headSha?.slice(0, 12) ?? 'no head'}) to ${input.remote} as ${remoteBranch}`,
  });
  const pr = await gate.request({
    kind: 'pr', command: ghPrCreateCommand({ head: remoteBranch, title, bodyFile: bodyPath, base: input.base, draft }), cwd: record.repoDir,
    reason: `open ${draft ? 'a draft ' : 'a '}pull request from ${remoteBranch}; approve after ${push.tier === 'always-pause' ? push.gate.id : 'the push'}`,
  });
  if (push.tier !== 'always-pause' || pr.tier !== 'always-pause') throw new Error('a push and a pull request must pause');
  return {
    pr: { remote: input.remote, remoteBranch, base: input.base ?? null, title, bodyPath, draft, pushGate: push.gate.id, prGate: pr.gate.id, requestedAt: new Date().toISOString() },
    gates: [push.gate, pr.gate],
  };
}

export type PrStatus = {
  gates: GateEntry[];
  verdict: PrVerdict | null;
  heads: { local: string | null; remote: string | null };
  state: { valid: boolean; reason: string } | null;
};

/**
 * The run's gates and its verdict. The verdict is void when the local integration branch, or the pushed branch as
 * this repo last saw it (`refs/remotes/<remote>/concilium/<run-id>`, no network), is at another head.
 */
export async function prStatus(record: CodeRunRecord, runsDir: string): Promise<PrStatus> {
  const gates = await listGates(runsDir, record.id);
  const branch = record.synthesis?.branch;
  const local = branch ? await refHead(record.repoDir, `refs/heads/${branch}`) : null;
  const remote = record.pr ? await refHead(record.repoDir, `refs/remotes/${record.pr.remote}/${record.pr.remoteBranch}`) : null;
  const verdict = record.prVerdict ?? null;
  return { gates, verdict, heads: { local, remote }, state: verdict ? verdictState(verdict, { local, remote }) : null };
}
