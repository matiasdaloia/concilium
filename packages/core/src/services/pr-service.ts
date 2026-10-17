/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decideVerdict,
  draftReason,
  isTrailPath,
  parseReview,
  pickVerifier,
  PR_BODY,
  prBody,
  prTitle,
  reviewPrompt,
  shipSource,
  VERIFICATION_REPORT,
  verdictState,
  verificationMarkdown,
  verifierSpec,
  type PrRequest,
  type PrVerdict,
} from '../domain/code-council/shipping.js';
import { testGate, type SurvivalCell } from '../domain/verification/adversarial.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import { CliCouncilGateway } from '../adapters/cli/cli-council-gateway.js';
import { GateRunner } from '../adapters/gate-runner.js';
import { changedFiles, detachedWorktree, patchId, refHead } from '../adapters/git-worktree-workspace.js';
import { createLogger } from '../shared/logger.js';
import { ActionGate, ghPrCreateCommand, gitPushCommand, listGates, type GateEntry } from './action-gate.js';
import { runTestInLane } from './adversarial-service.js';
import type { CodeRunRecord } from './code-service.js';
import { JUDGE_DIFF_LIMIT, usableClis } from './ranking-service.js';
import { committedTrailDir } from './trail-service.js';

const log = createLogger('pr');

/** The remote branch a run's verified commit is pushed to. */
export function prBranch(runId: string): string {
  return `concilium/${runId}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The commit to ship from `branchHead`: its parent when the head is the run's trail commit and touches only
 * `.concilium/runs/`, else the head itself.
 */
async function shipCommit(repoDir: string, branchHead: string, trailSha: string | null): Promise<{ sha: string; trailSha: string | null }> {
  if (trailSha !== branchHead) return { sha: branchHead, trailSha: null };
  const parent = await refHead(repoDir, `${branchHead}^`);
  if (!parent || !(await changedFiles(repoDir, parent, branchHead)).every(isTrailPath)) return { sha: branchHead, trailSha: null };
  return { sha: parent, trailSha };
}

export type VerifyPrInput = {
  record: CodeRunRecord;
  /** Where `verification.md` is written. */
  runDir: string;
  drivers: ReadonlyMap<string, HeadlessCliDriver>;
  /** The configured verifier (`cli[:model]`), or `auto`/absent to pick one. */
  verifier?: string;
  runner?: GateRunner;
  signal?: AbortSignal;
  onStep?: (line: string) => void;
};

/**
 * M7.2, M7.3. Verifies the commit a PR would ship: the integration branch (or a single candidate's branch) at its
 * head, without the trail commit. A CLI of a family that wrote none of it (a configured one first) re-runs the run's
 * gates and its valid adversarial suite in a fresh worktree there, then reviews the diff read-only. With no such CLI,
 * an author-family one verifies, flagged `sameFamily`. BLOCKED when no CLI is usable or the commit would carry the
 * trail. The verdict is keyed to the commit, the base and the patch-id, and written to `verification.md`.
 */
export async function verifyPr(input: VerifyPrInput): Promise<PrVerdict> {
  const { record } = input;
  const source = shipSource(record);
  const verdict: PrVerdict = {
    verdict: 'BLOCKED', reason: '', notes: [], verifier: null, authorFamilies: [], branch: null, branchHead: null, headSha: null, trailSha: null,
    baseSha: record.baseSha, patchId: null, gates: {}, tests: {}, review: null, verifiedAt: new Date().toISOString(), reportPath: null,
  };
  const finish = async (): Promise<PrVerdict> => {
    await mkdir(input.runDir, { recursive: true });
    verdict.reportPath = join(input.runDir, VERIFICATION_REPORT);
    await writeFile(verdict.reportPath, verificationMarkdown(verdict, { id: record.id, task: record.task }));
    log.info(`run ${record.id}: ${verdict.verdict} at ${verdict.headSha ?? 'no commit'} (${verdict.reason})`);
    return verdict;
  };

  if ('blocked' in source) {
    verdict.reason = source.blocked;
    return finish();
  }
  verdict.branch = source.branch;
  verdict.authorFamilies = source.authorFamilies;
  verdict.branchHead = await refHead(record.repoDir, `refs/heads/${source.branch}`);
  if (!verdict.branchHead) {
    verdict.reason = `${source.branch} does not exist in ${record.repoDir}`;
    return finish();
  }
  const ship = await shipCommit(record.repoDir, verdict.branchHead, record.trail?.commitSha ?? null);
  verdict.trailSha = ship.trailSha;
  const trailFiles = (await changedFiles(record.repoDir, record.baseSha, ship.sha)).filter(isTrailPath);
  if (trailFiles.length > 0) {
    verdict.reason = `${ship.sha.slice(0, 12)} would ship decision-trail files (${trailFiles.join(', ')}); only a trail commit at the head of ${source.branch} is left out`;
    return finish();
  }
  verdict.headSha = ship.sha;
  verdict.patchId = await patchId(record.repoDir, record.baseSha, ship.sha);
  const picked = pickVerifier(verdict.authorFamilies, await usableClis(input.drivers), input.verifier ?? null);
  verdict.verifier = picked.verifier;
  verdict.notes.push(...picked.notes);
  if (!verdict.verifier) {
    verdict.reason = 'no installed, signed-in agent CLI can verify';
    return finish();
  }
  if (!record.verification) {
    verdict.reason = 'the run has no gate plan to re-run';
    return finish();
  }
  const verifier = verdict.verifier;
  input.onStep?.(
    `verifier: ${verifierSpec(verifier)} (${verifier.family ?? 'unknown family'})${verifier.sameFamily ? ', SAME FAMILY' : ''}, authors: ${verdict.authorFamilies.join(', ')}`,
  );

  const runner = input.runner ?? new GateRunner();
  const plan = record.verification.plan;
  const lane = await detachedWorktree(record.repoDir, ship.sha);
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
          const run = await runTestInLane(runner, gate, from.path, t.files, lane.path, ship.sha, input.signal);
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

  const diff = await runner.diff(record.repoDir, record.baseSha, ship.sha);
  const checks = [...Object.entries(verdict.gates).map(([n, o]) => `gate ${n}: ${o}`), ...Object.entries(verdict.tests).map(([id, c]) => `adversarial test ${id}: ${c}`)];
  const prompt = reviewPrompt(record.task, diff.length > JUDGE_DIFF_LIMIT ? `${diff.slice(0, JUDGE_DIFF_LIMIT)}\n... (diff truncated at ${JUDGE_DIFF_LIMIT} characters)` : diff, checks);
  try {
    const response = await new CliCouncilGateway({ drivers: input.drivers }).query(verifierSpec(verifier), [{ role: 'user', content: prompt }], undefined, input.signal);
    verdict.review = response ? parseReview(response.content) : null;
    if (!response) verdict.notes.push(`${verifierSpec(verifier)} gave no review`);
  } catch (err) {
    verdict.notes.push(`the review failed: ${errorMessage(err)}`);
  }

  const baseline = Object.fromEntries((record.verification.baseline?.gates ?? []).map((g) => [g.name, g.outcome]));
  const decided = decideVerdict({ headSha: ship.sha, baseline, gates: verdict.gates, tests: verdict.tests, review: verdict.review });
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
 * Writes `pr-body.md` and asks for two paused actions keyed to the verified commit: push exactly that commit to
 * `concilium/<run-id>` on the remote, then open the PR from it. Nothing runs until each gate is approved. Asked again
 * for the same commit, it reuses the gates; for another commit, the pending ones are superseded. The PR is a draft
 * unless the verdict is PASS or PASS+NOTES from a verifier outside the author families.
 */
export async function requestPr(input: RequestPrInput): Promise<{ pr: PrRequest; gates: GateEntry[]; reused: boolean; superseded: GateEntry[] }> {
  const { record, verdict: v } = input;
  if (!v.headSha) throw new Error(`run ${record.id} has no verified commit to push (${v.verdict}: ${v.reason})`);
  const synthesisMd = record.synthesis?.synthesisPath ? await readFile(record.synthesis.synthesisPath, 'utf8').catch(() => null) : null;
  const body = prBody({ runId: record.id, synthesisMd, dissent: record.dissent.records, verdict: v, trailDir: committedTrailDir(record.id) });
  await mkdir(input.runDir, { recursive: true });
  const bodyPath = join(input.runDir, PR_BODY);
  await writeFile(bodyPath, body);

  const remoteBranch = prBranch(record.id);
  const title = prTitle(record.task);
  const draft = draftReason(v);
  const gate = input.gate ?? new ActionGate({ runId: record.id, runDir: input.runDir });
  const push = await gate.request({
    kind: 'push', command: gitPushCommand(input.remote, `${v.headSha}:refs/heads/${remoteBranch}`), cwd: record.repoDir, key: v.headSha,
    reason: `push ${v.headSha.slice(0, 12)} (verdict ${v.verdict} on ${v.branch}) to ${input.remote} as ${remoteBranch}`,
  });
  if (push.tier !== 'always-pause') throw new Error('a push must pause');
  const pr = await gate.request({
    kind: 'pr', command: ghPrCreateCommand({ head: remoteBranch, title, bodyFile: bodyPath, base: input.base, draft: draft !== null }), cwd: record.repoDir, key: v.headSha,
    reason: `open ${draft ? `a draft (${draft}) ` : 'a '}pull request from ${remoteBranch}; approve after ${push.gate.id}`,
  });
  if (pr.tier !== 'always-pause') throw new Error('a pull request must pause');
  return {
    pr: {
      remote: input.remote, remoteBranch, sha: v.headSha, base: input.base ?? null, title, bodyPath, draftReason: draft,
      pushGate: push.gate.id, prGate: pr.gate.id, requestedAt: new Date().toISOString(),
    },
    gates: [push.gate, pr.gate],
    reused: push.reused && pr.reused,
    superseded: [...push.superseded, ...pr.superseded],
  };
}

export type PrStatus = {
  gates: GateEntry[];
  verdict: PrVerdict | null;
  /** The branch the run ships from, and what it holds now. */
  branch: string | null;
  heads: { local: string | null; remote: string | null };
  state: { valid: boolean; reason: string } | null;
};

/**
 * The run's gates and its verdict. The verdict is void when the local branch is at another head than the one
 * verified, or the pushed branch as this repo last saw it (`refs/remotes/<remote>/concilium/<run-id>`, no network)
 * is at another commit than the one verified.
 */
export async function prStatus(record: CodeRunRecord, runsDir: string): Promise<PrStatus> {
  const gates = await listGates(runsDir, record.id);
  const source = shipSource(record);
  const branch = record.prVerdict?.branch ?? ('blocked' in source ? null : source.branch);
  const local = branch ? await refHead(record.repoDir, `refs/heads/${branch}`) : null;
  const remote = record.pr ? await refHead(record.repoDir, `refs/remotes/${record.pr.remote}/${record.pr.remoteBranch}`) : null;
  const verdict = record.prVerdict ?? null;
  return { gates, verdict, branch, heads: { local, remote }, state: verdict ? verdictState(verdict, { local, remote }) : null };
}
