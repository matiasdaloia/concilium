/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProviderInfo } from '../domain/agent/providers.js';
import { configuredJudge, pickJudge } from '../domain/code-council/judging.js';
import type { TaskType } from '../domain/code-council/playbooks.js';
import type { Ranking } from '../domain/code-council/ranking.js';
import {
  graftPrompt,
  integratorBrief,
  parseGraftAnswer,
  RESULT_PATCH,
  settleDivergence,
  SYNTHESIS_REPORT,
  synthesisMarkdown,
  type Graft,
  type GraftEvidence,
  type GraftIdea,
  type GraftPack,
  type Synthesis,
  type SynthesisChecks,
} from '../domain/code-council/synthesis.js';
import { testGate, type AdversarialTest, type SurvivalCell } from '../domain/verification/adversarial.js';
import { parseDiff } from '../domain/verification/integrity.js';
import type { HeadlessCliDriver } from '../ports/headless-cli-driver.js';
import type { Workspace, WorkspaceManager } from '../ports/workspace.js';
import { CliCouncilGateway } from '../adapters/cli/cli-council-gateway.js';
import { GateRunner } from '../adapters/gate-runner.js';
import { INTEGRATION_CANDIDATE } from '../adapters/git-worktree-workspace.js';
import { createLogger } from '../shared/logger.js';
import { runTestInLane, type AdversarialRound } from './adversarial-service.js';
import type { CodeAgent, CodeCandidate } from './code-service.js';
import { JUDGE_DIFF_LIMIT, usableClis } from './ranking-service.js';
import { runDriver } from './run-driver.js';
import type { RunVerification } from './verification-service.js';

const log = createLogger('synthesis');

export type SynthesisInput = {
  task: string;
  type: TaskType;
  repoDir: string;
  runId: string;
  baseSha: string;
  /** Where `result.patch` and `synthesis.md` are written. */
  runDir: string;
  candidates: CodeCandidate[];
  ranking: Ranking;
  verification?: RunVerification;
  adversarial?: AdversarialRound;
  drivers: ReadonlyMap<string, HeadlessCliDriver>;
  workspace: WorkspaceManager;
  /** The judge role's `cli[:model]`, which names the grafts. Without it, `pickJudge` takes a usable CLI of another family. */
  pickerSpec?: string;
  /** The integrator role. Without it, the base's CLI and model fold in the grafts. */
  integrator?: CodeAgent;
  /**
   * The adversarial tests of a `disjoint-survival` divergence. They are checked after each graft like the valid
   * suite, re-run at the integration head, and unless that head passes the gates and all of them, no patch is kept.
   */
  conflictTests?: AdversarialTest[];
  /** Wall-clock limit per integrator run. */
  timeoutMs: number;
  runner?: GateRunner;
  signal?: AbortSignal;
  onGraftDone?: (graft: Graft) => void;
};

/** What every graft is applied and checked with. */
type Context = SynthesisInput & {
  runner: GateRunner;
  signal: AbortSignal;
  base: CodeCandidate;
  integration: Workspace;
  validTests: AdversarialTest[];
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function familyOf(c: CodeCandidate): string {
  return getProviderInfo(c.provider)?.family ?? c.provider;
}

function emptySynthesis(): Synthesis {
  return {
    base: null, branch: null, worktree: null, headSha: null, picker: null, notes: [], grafts: [], dropouts: [],
    checks: null, patchPath: null, synthesisPath: null, mergeable: false, mergeCheck: null,
  };
}

/** A synthesis that did not run, and why. */
export function skippedSynthesis(skipped: string): Synthesis {
  return { skipped, ...emptySynthesis() };
}

/** One read-only CLI run, from another family than the base and the donors when one is usable, names the grafts. */
async function pickGrafts(ctx: Context, donors: CodeCandidate[], synthesis: Synthesis): Promise<GraftIdea[]> {
  const families = [...new Set([ctx.base, ...donors].map(familyOf))];
  const choice = ctx.pickerSpec ? configuredJudge(ctx.pickerSpec, families) : pickJudge(families, await usableClis(ctx.drivers));
  if (!choice) {
    synthesis.notes.push('no agent CLI is installed and signed in to name grafts');
    return [];
  }
  synthesis.picker = choice.sameFamily && !ctx.pickerSpec
    ? { ...choice, sameFamilyReason: `no CLI outside the candidates' families (${families.join(', ')}) is usable, so ${choice.provider} names the grafts` }
    : choice;

  const pack = async (c: CodeCandidate, label: string): Promise<GraftPack & { files: string[] }> => {
    const diff = await ctx.runner.diff(ctx.repoDir, ctx.baseSha, c.headSha!);
    return {
      label,
      diff: diff.length > JUDGE_DIFF_LIMIT ? `${diff.slice(0, JUDGE_DIFF_LIMIT)}\n... (diff truncated at ${JUDGE_DIFF_LIMIT} characters)` : diff,
      // The agent and judge lines can name a CLI or a family.
      evidence: (c.report?.evidence ?? []).filter((e) => e.kind !== 'agent' && e.kind !== 'judge').map((e) => `${e.ok ? 'ok' : 'issue'}, ${e.kind}: ${e.detail}`),
      files: parseDiff(diff).map((f) => f.path),
    };
  };
  const labels = donors.map((_, i) => String.fromCharCode(65 + i));
  const others = await Promise.all(donors.map((c, i) => pack(c, labels[i])));
  const prompt = graftPrompt(ctx.task, await pack(ctx.base, 'Base'), others);

  const response = await new CliCouncilGateway({ drivers: ctx.drivers }).query(choice.provider, [{ role: 'user', content: prompt }], undefined, ctx.signal);
  if (!response) {
    synthesis.notes.push(`${choice.provider} gave no answer, so no graft was named`);
    return [];
  }
  try {
    const parsed = parseGraftAnswer(response.content, Object.fromEntries(others.map((o) => [o.label, o.files])));
    synthesis.notes.push(...parsed.notes);
    return parsed.grafts.map(({ label, ...idea }) => ({ candidateId: donors[labels.indexOf(label)].candidateId, ...idea }));
  } catch (err) {
    synthesis.notes.push(`${errorMessage(err)}, so no graft was named`);
    return [];
  }
}

/** The gates and the valid adversarial tests at the integration head; tests run only when the test gate passes there. */
async function check(ctx: Context, sha: string): Promise<{ checks: SynthesisChecks; outputs: Map<string, string> }> {
  const outputs = new Map<string, string>();
  const lane = await ctx.runner.runLane(INTEGRATION_CANDIDATE, ctx.integration.path, ctx.verification!.plan, { signal: ctx.signal });
  const gates = Object.fromEntries(lane.gates.map((g) => [g.name, g.outcome]));
  for (const g of lane.gates) outputs.set(`gate:${g.name}`, g.output);
  const gate = testGate(ctx.verification!.plan);
  const tests: Record<string, SurvivalCell> = {};
  for (const t of ctx.validTests) {
    const from = ctx.adversarial?.adversaries.find((a) => a.family === t.author)?.worktree;
    tests[t.id] = 'error';
    if (!gate || gates[gate.name] !== 'pass' || !from) continue;
    const run = await runTestInLane(ctx.runner, gate, from, t.files, ctx.integration.path, sha, ctx.signal);
    tests[t.id] = run.outcome === 'pass' || run.outcome === 'fail' ? run.outcome : 'error';
    outputs.set(`test:${t.id}`, run.output);
  }
  return { checks: { sha, gates, tests }, outputs };
}

/**
 * A fresh integrator run (the integrator role, else the base's CLI and model, write mode) folds one graft into the
 * integration worktree, and Concilium commits it. The graft stays only when no gate or valid adversarial test that
 * passed before it fails after it, and it weakens no test; otherwise its commit is reverted and the evidence recorded.
 */
async function applyGraft(ctx: Context, idea: GraftIdea, id: string, head: string, before: SynthesisChecks): Promise<{ graft: Graft; head: string; checks: SynthesisChecks }> {
  const who = ctx.integrator ?? { provider: ctx.base.provider, model: ctx.base.model ?? undefined };
  const integrator: Graft['integrator'] = { provider: who.provider, model: who.model ?? null, status: 'error', durationMs: 0, errors: [], finalText: '', brief: null };
  const graft: Graft = { id, ...idea, status: 'rejected', commitSha: null, revertSha: null, reason: '', evidence: [], integrator };

  const patchDir = await mkdtemp(join(tmpdir(), 'concilium-graft-'));
  const startedAt = Date.now();
  try {
    const source = ctx.candidates.find((c) => c.candidateId === idea.candidateId)!;
    const sourcePatch = join(patchDir, 'source.patch');
    await writeFile(sourcePatch, await ctx.runner.diff(ctx.repoDir, ctx.baseSha, source.headSha!));
    integrator.brief = integratorBrief({ task: ctx.task, graft: { ...idea, id }, worktree: ctx.integration.path, branch: ctx.integration.branch, sourcePatch });
    const driver = ctx.drivers.get(who.provider);
    if (!driver) throw new Error(`No agent CLI driver for "${who.provider}"`);
    const report = await runDriver(driver, integrator.brief, who.model, ctx.timeoutMs, ctx.signal);
    integrator.status = report.status;
    integrator.errors.push(...report.errors);
    integrator.finalText = report.finalText;
  } catch (err) {
    integrator.status = 'error';
    integrator.errors.push(errorMessage(err));
  } finally {
    integrator.durationMs = Date.now() - startedAt;
    await rm(patchDir, { recursive: true, force: true });
  }

  const message = `concilium: ${id} from ${idea.candidateId} for run ${ctx.runId}\n\n${idea.instruction}\n\nWhy: ${idea.why}\nSource: ${idea.candidateId} (${idea.files.join(', ')})\n`;
  const commit = await ctx.workspace.commit({ repoDir: ctx.repoDir, runId: ctx.runId, candidateId: INTEGRATION_CANDIDATE, message });
  if (commit.committed) graft.commitSha = commit.headSha;

  let after = before;
  const evidence: GraftEvidence[] = [];
  if (integrator.status !== 'ok') {
    evidence.push({ kind: 'integrator', detail: `the integrator ended with ${integrator.status}${integrator.errors[0] ? `: ${integrator.errors[0].split('\n')[0]}` : ''}` });
  } else if (!commit.committed) {
    evidence.push({ kind: 'integrator', detail: 'the integrator made no change' });
  } else {
    for (const f of await ctx.runner.integrity(ctx.repoDir, head, commit.headSha)) {
      if (f.severity === 'disqualify') evidence.push({ kind: 'integrity', detail: f.message, sha: commit.headSha, output: f.evidence });
    }
    const result = await check(ctx, commit.headSha);
    after = result.checks;
    for (const [name, outcome] of Object.entries(after.gates)) {
      if (before.gates[name] === 'pass' && outcome !== 'pass') {
        evidence.push({ kind: 'gate', detail: `gate ${name} passed before the graft and is ${outcome} after it`, sha: commit.headSha, output: result.outputs.get(`gate:${name}`) });
      }
    }
    for (const t of ctx.validTests) {
      if (before.tests[t.id] === 'pass' && after.tests[t.id] !== 'pass') {
        const output = result.outputs.get(`test:${t.id}`);
        evidence.push({ kind: 'test', detail: `adversarial test ${t.id} (${t.specClause}) passed before the graft and is ${after.tests[t.id]} after it`, sha: commit.headSha, ...(output ? { output } : {}) });
      }
    }
  }

  if (evidence.length === 0) {
    log.info(`run ${ctx.runId}: ${id} from ${idea.candidateId} applied at ${commit.headSha}`);
    return { graft: { ...graft, status: 'applied' }, head: commit.headSha, checks: after };
  }
  graft.evidence = evidence;
  graft.reason = evidence.map((e) => e.detail).join('; ');
  let next = commit.headSha;
  if (commit.committed) {
    graft.revertSha = await ctx.workspace.revert({
      repoDir: ctx.repoDir, runId: ctx.runId, candidateId: INTEGRATION_CANDIDATE, sha: commit.headSha,
      message: `concilium: revert ${id} for run ${ctx.runId}\n\nRejected: ${graft.reason}\n`,
    });
    next = graft.revertSha;
  }
  log.info(`run ${ctx.runId}: ${id} from ${idea.candidateId} rejected: ${graft.reason}`);
  // A reverted graft leaves the tree as it was, so the earlier checks still hold.
  return { graft, head: next, checks: before };
}

/**
 * M5.1. The winner is the base: `concilium/<run-id>/integration` starts at its head. A read-only CLI names up to 2
 * grafts per other candidate that is neither blocked nor disqualified; each is folded in by a fresh integrator run,
 * one commit per graft, and re-verified with the gates and the valid adversarial suite. Then the integration branch
 * is written to `result.patch`, checked against the target's current `HEAD`, and reported in `synthesis.md`.
 * With `conflictTests` (M5.2), the patch is written only when the integration head settles the divergence.
 */
export async function synthesize(input: SynthesisInput): Promise<Synthesis> {
  const skip = skippedSynthesis;
  if (input.type === 'prototype') return skip('a prototype ends in a decision record, not a patch');
  if (input.candidates.length < 2) return skip('fewer than 2 candidates');
  const base = input.candidates.find((c) => c.candidateId === input.ranking.winner);
  if (!base?.headSha) return skip('no winner');
  if (!input.verification) return skip('the gates did not run, so no graft could be re-verified');

  const synthesis: Synthesis = { ...emptySynthesis(), base: { candidateId: base.candidateId, headSha: base.headSha, reason: input.ranking.reason } };
  const donors: CodeCandidate[] = [];
  for (const c of input.candidates) {
    if (c === base) continue;
    if (!c.headSha || c.report?.status === 'BLOCKED') {
      synthesis.dropouts.push({ candidateId: c.candidateId, reason: `BLOCKED: ${c.report?.reason ?? 'no branch head'}` });
    } else if (c.verification?.disqualified) {
      const finding = c.verification.integrity.find((f) => f.severity === 'disqualify');
      synthesis.dropouts.push({ candidateId: c.candidateId, reason: `disqualified: ${finding?.message ?? 'it weakened the tests'}` });
    } else {
      donors.push(c);
    }
  }

  try {
    const integration = await input.workspace.create({ repoDir: input.repoDir, runId: input.runId, candidateId: INTEGRATION_CANDIDATE, fromSha: base.headSha });
    synthesis.branch = integration.branch;
    synthesis.worktree = integration.path;
    synthesis.headSha = base.headSha;
    const valid = (input.adversarial?.tests ?? []).filter((t) => t.validity === 'evidence' || t.validity === 'regression-guard');
    const validTests = [...valid, ...(input.conflictTests ?? []).filter((t) => !valid.some((v) => v.id === t.id))];
    const ctx: Context = { ...input, runner: input.runner ?? new GateRunner(), signal: input.signal ?? new AbortController().signal, base, integration, validTests };

    // The base was checked at this very head, so its results are where the first graft starts from.
    let checks: SynthesisChecks = {
      sha: base.headSha,
      gates: Object.fromEntries((base.verification?.gates ?? []).map((g) => [g.name, g.outcome])),
      tests: Object.fromEntries(validTests.map((t) => [t.id, input.adversarial!.matrix[t.id]?.[base.candidateId] ?? 'error'])),
    };
    const ideas = donors.length > 0 ? await pickGrafts(ctx, donors, synthesis) : [];
    if (donors.length === 0) synthesis.notes.push('no other candidate can give a graft');
    for (const [i, idea] of ideas.entries()) {
      const result = await applyGraft(ctx, idea, `graft-${i + 1}`, synthesis.headSha, checks);
      synthesis.grafts.push(result.graft);
      synthesis.headSha = result.head;
      checks = result.checks;
      input.onGraftDone?.(result.graft);
    }
    if (input.conflictTests) {
      // The suite again at the very head the patch would come from, which a revert or no graft leaves unchecked.
      checks = (await check(ctx, synthesis.headSha)).checks;
      const baseline = Object.fromEntries((input.verification.baseline?.gates ?? []).map((g) => [g.name, g.outcome]));
      synthesis.divergence = settleDivergence(checks, input.conflictTests.map((t) => t.id), baseline);
    }
    synthesis.checks = checks;

    // An unresolved divergence keeps the integration branch for inspection, but no patch: the run needs a reframe.
    if (synthesis.divergence?.resolved !== false) {
      const patch = await input.workspace.patch({ repoDir: input.repoDir, runId: input.runId, candidateId: INTEGRATION_CANDIDATE });
      await mkdir(input.runDir, { recursive: true });
      synthesis.patchPath = join(input.runDir, RESULT_PATCH);
      await writeFile(synthesis.patchPath, patch);
      synthesis.mergeCheck = await input.workspace.checkPatch({ repoDir: input.repoDir, patch });
      synthesis.mergeable = synthesis.mergeCheck.applies;
    }
  } catch (err) {
    synthesis.notes.push(`synthesis failed: ${errorMessage(err)}`);
    log.error(`run ${input.runId}: synthesis failed: ${errorMessage(err)}`);
  }

  try {
    await mkdir(input.runDir, { recursive: true });
    const path = join(input.runDir, SYNTHESIS_REPORT);
    await writeFile(path, synthesisMarkdown(synthesis, { id: input.runId, task: input.task, baseSha: input.baseSha }));
    synthesis.synthesisPath = path;
  } catch (err) {
    synthesis.notes.push(`could not write ${SYNTHESIS_REPORT}: ${errorMessage(err)}`);
  }
  log.info(`run ${input.runId}: synthesis on ${base.candidateId}, ${synthesis.grafts.filter((g) => g.status === 'applied').length}/${synthesis.grafts.length} grafts applied, mergeable ${synthesis.mergeable}`);
  return synthesis;
}
