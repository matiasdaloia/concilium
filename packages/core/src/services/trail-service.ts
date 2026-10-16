/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { Dissent } from '../domain/code-council/dissent.js';
import type { Judgment } from '../domain/code-council/judging.js';
import { TASK_TYPES, type TaskTypeChoice } from '../domain/code-council/playbooks.js';
import type { Ranking } from '../domain/code-council/ranking.js';
import type { Divergence, Reframe } from '../domain/code-council/reframe.js';
import type { FrozenRubric } from '../domain/code-council/rubric.js';
import type { Graft, Synthesis } from '../domain/code-council/synthesis.js';
import {
  auditTrail,
  commitPointer,
  DECISIONS_FILE,
  decisionsHeader,
  EVENTS_FILE,
  filePointer,
  formatDecisionRow,
  parseDecisions,
  parseEvents,
  RUBRIC_FILE,
  trailPointers,
  type Decision,
  type TrailProblem,
} from '../domain/code-council/trail.js';
import type { CodeRoleMap } from '../domain/roles/roles.js';
import type { WorkspaceManager } from '../ports/workspace.js';
import { commitExists, INTEGRATION_CANDIDATE } from '../adapters/git-worktree-workspace.js';
import { createLogger } from '../shared/logger.js';
import type { AdversarialRound } from './adversarial-service.js';
import type { CandidateVerification, RunVerification } from './verification-service.js';

const log = createLogger('trail');

/** The files of the trail committed on the integration branch, under `.concilium/runs/<run-id>/`, when the run wrote them. */
export const COMMITTED_TRAIL_FILES = [DECISIONS_FILE, 'dissent.json', 'synthesis.md'] as const;

/** Where the trail of a run is committed on its integration branch. */
export function committedTrailDir(runId: string): string {
  return `.concilium/runs/${runId}`;
}

/** The decision trail of a code run, as recorded on the run. */
export type RunTrail = {
  decisionsPath: string;
  eventsPath: string;
  rows: number;
  /** The commit on the integration branch holding the trail; null when there is no branch or the commit is turned off. */
  commitSha: string | null;
  errors: string[];
};

function counts(values: string[]): string {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n].map(([v, c]) => `${v} ${c}`).join(', ');
}

/** The decisions of a code run, one builder per step, in the order the orchestrator makes them. */
export const decisions = {
  taskType(choice: TaskTypeChoice, baseSha: string): Decision {
    return {
      step: 'task-type', decision: 'pick the playbook', chosen: choice.type, alternatives: TASK_TYPES.filter((t) => t !== choice.type),
      evidence: [commitPointer(baseSha)], reason: `${choice.source}: ${choice.reason}`,
    };
  },

  rubric(rubric: FrozenRubric): Decision {
    const from = rubric.source === 'framer' ? `tailored by ${rubric.framer}` : `playbook defaults${rubric.note ? ` (${rubric.note})` : ''}`;
    return {
      step: 'rubric', decision: 'freeze the rubric before fan-out', chosen: `sha256:${rubric.sha256}`, alternatives: [],
      evidence: [filePointer(RUBRIC_FILE)], reason: `${rubric.criteria.length} criteria (${rubric.criteria.map((c) => c.name).join(', ')}), ${from}`,
    };
  },

  candidates(ids: string[], roles: CodeRoleMap, baseSha: string): Decision {
    const role = (name: keyof CodeRoleMap) => {
      const { value, source } = roles[name];
      return `${name} ${Array.isArray(value) ? value.join(',') : value || '-'} (${source})`;
    };
    return {
      step: 'candidates', decision: 'fan out the candidates', chosen: ids.join(', '), alternatives: [],
      evidence: [commitPointer(baseSha)], reason: (['planner', 'implementer', 'adversary', 'judge', 'integrator'] as const).map(role).join('; '),
    };
  },

  gatePlan(run: RunVerification, baseSha: string): Decision {
    const base = run.baseline ? `base: ${run.baseline.gates.map((g) => `${g.name} ${g.outcome}`).join(', ') || 'no gate'}` : 'base not checked';
    return {
      step: 'gate-plan', decision: 'decide the gates from the base', chosen: run.plan.gates.map((g) => g.name).join(', ') || 'none', alternatives: [],
      evidence: [commitPointer(baseSha)], reason: [`from ${run.plan.source}`, ...run.plan.notes, ...run.errors, base].join('; '),
    };
  },

  verification(candidateId: string, v: CandidateVerification | null, baseSha: string): Decision {
    const verdict = v === null ? 'not checked' : v.disqualified ? 'DISQUALIFIED' : v.status;
    const reason = v === null
      ? 'no head to check'
      : [`new failures: ${v.newFailures.join(', ') || 'none'}`, `penalties: ${v.penalties}`, ...v.integrity.map((f) => `${f.severity}: ${f.message}`), ...v.errors.map((e) => e.split('\n')[0])].join('; ');
    return {
      step: 'verification', decision: `verify ${candidateId}`, chosen: verdict, alternatives: ['PASS', 'ISSUES', 'DISQUALIFIED'].filter((s) => s !== verdict),
      evidence: [commitPointer(v?.sha ?? baseSha)], reason,
    };
  },

  adversarial(round: AdversarialRound, baseSha: string): Decision {
    const heads = round.adversaries.flatMap((a) => (a.headSha ? [commitPointer(a.headSha)] : []));
    const survival = Object.entries(round.survival).map(([id, s]) => `${id} ${s.survived}/${s.counted}`).join(', ');
    return {
      step: 'adversarial', decision: 'classify the adversarial tests', chosen: round.skipped ? 'skipped' : counts(round.tests.map((t) => t.validity)) || 'no test',
      alternatives: [], evidence: heads.length ? heads : [commitPointer(baseSha)],
      reason: round.skipped ?? `${round.tests.length} tests by ${round.adversaries.map((a) => `${a.lane} (${a.status})`).join(', ') || 'no adversary'}; survival ${survival || 'none'}`,
    };
  },

  judgment(j: Judgment, heads: Record<string, string | null>, baseSha: string): Decision {
    const shas = j.candidates.flatMap((id) => (heads[id] ? [commitPointer(heads[id]!)] : []));
    const order = Object.entries(j.totals).sort((a, b) => b[1] - a[1]).map(([id, t]) => `${id} ${t}`).join(', ');
    return {
      step: 'judge', decision: `judge the tie ${j.candidates.join(', ')}`, chosen: j.status === 'PASS' ? order : j.status, alternatives: [],
      evidence: shas.length ? shas : [commitPointer(baseSha)],
      reason: `${j.judge ?? 'no judge'}: ${j.reason}${j.sameFamily ? `; same-family judge: ${j.sameFamilyReason}` : ''}`,
    };
  },

  ranking(ranking: Ranking, heads: Record<string, string | null>, baseSha: string): Decision {
    const winnerHead = ranking.winner ? heads[ranking.winner] : null;
    return {
      step: 'ranking', decision: 'rank on the evidence', chosen: ranking.winner ?? 'none',
      alternatives: ranking.order.map((e) => e.candidateId).filter((id) => id !== ranking.winner),
      evidence: [commitPointer(winnerHead ?? baseSha)], reason: `${ranking.reason}; order ${ranking.order.map((e) => `${e.rank}. ${e.candidateId}`).join(', ')}`,
    };
  },

  basePick(s: Synthesis, ranking: Ranking, baseSha: string, synthesisFile: string | null): Decision {
    return {
      step: 'base-pick', decision: 'pick the synthesis base', chosen: s.base?.candidateId ?? 'none',
      alternatives: ranking.order.map((e) => e.candidateId).filter((id) => id !== s.base?.candidateId),
      evidence: [commitPointer(s.base?.headSha ?? baseSha), ...(synthesisFile ? [filePointer(synthesisFile)] : [])],
      reason: s.base ? `${s.base.reason}; dropouts: ${s.dropouts.map((d) => d.candidateId).join(', ') || 'none'}` : `synthesis skipped: ${s.skipped ?? 'no base'}`,
    };
  },

  graft(g: Graft, fallbackSha: string): Decision {
    const shas = [g.commitSha, g.revertSha, ...g.evidence.map((e) => e.sha)].filter((s): s is string => !!s);
    return {
      step: 'graft', decision: `${g.id} from ${g.candidateId} (${g.files.join(', ')})`, chosen: g.status, alternatives: [g.status === 'applied' ? 'rejected' : 'applied'],
      evidence: [...new Set(shas.length ? shas : [fallbackSha])].map(commitPointer), reason: g.status === 'applied' ? g.why : g.reason,
    };
  },

  divergence(divergence: Divergence[], s: Synthesis | undefined, reframe: Reframe | undefined, baseSha: string, reportFile: string | null): Decision {
    const chosen = divergence.length === 0 ? 'none' : s?.divergence ? (s.divergence.resolved ? 'grafted, resolved' : 'grafted, then reframe') : 'reframe';
    const details = [...divergence.map((d) => `${d.trigger}: ${d.detail}`), ...(s?.divergence ? [s.divergence.reason] : []), ...(reframe ? [`${reframe.questions.length} questions`] : [])];
    return {
      step: 'divergence', decision: 'check the candidates for divergence', chosen, alternatives: [],
      evidence: reportFile ? [filePointer(reportFile)] : [commitPointer(baseSha)], reason: details.join('; ') || 'no trigger fired',
    };
  },

  dissent(records: Dissent[], baseSha: string, dissentFile: string | null): Decision {
    const open = records.filter((d) => d.resolution === 'open');
    return {
      step: 'dissent', decision: 'record the dissent', chosen: `${open.length} open of ${records.length}`, alternatives: [],
      evidence: dissentFile ? [filePointer(dissentFile)] : [commitPointer(baseSha)],
      reason: records.map((d) => `${d.id} ${d.source} ${d.resolution}`).join(', ') || 'no dissent',
    };
  },

  mergeable(s: Synthesis, baseSha: string, patchFile: string | null): Decision {
    const check = s.mergeCheck && (s.mergeCheck.applies ? `git apply --check passes against HEAD ${s.mergeCheck.targetSha}` : `git apply --check fails: ${s.mergeCheck.output.split('\n')[0]}`);
    return {
      step: 'mergeable', decision: 'label the patch', chosen: s.mergeable ? 'mergeable' : 'not mergeable', alternatives: [s.mergeable ? 'not mergeable' : 'mergeable'],
      evidence: [...(patchFile ? [filePointer(patchFile)] : []), commitPointer(s.headSha ?? baseSha)],
      reason: [s.mergeBlock, check, s.skipped, s.divergence?.reason].filter(Boolean).join('; ') || 'no patch',
    };
  },
};

/**
 * M6.2. The orchestrator's own record of a code run, in the run directory: `events.jsonl`, every event in order,
 * and `decisions.tsv`, one row per decision, each pointing at its `decision` event. Both are append-only; writes are
 * queued so parallel callbacks keep their order. A failed write is logged and kept in `errors`; it never stops the run.
 */
export class DecisionTrail {
  readonly decisionsPath: string;
  readonly eventsPath: string;
  readonly errors: string[] = [];
  rows = 0;
  private seq = 0;
  private queue: Promise<void>;

  constructor(readonly dir: string, run: { runId: string; repoDir: string; baseSha: string }) {
    this.decisionsPath = join(dir, DECISIONS_FILE);
    this.eventsPath = join(dir, EVENTS_FILE);
    this.queue = Promise.resolve();
    this.enqueue(async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(this.decisionsPath, decisionsHeader());
    });
    this.event('run-start', run);
  }

  private enqueue(write: () => Promise<void>): void {
    this.queue = this.queue.then(write).catch((err: unknown) => {
      const message = `could not write the decision trail: ${err instanceof Error ? err.message : String(err)}`;
      log.error(message);
      this.errors.push(message);
    });
  }

  /** A path relative to the run directory, as a `file:` pointer names it. */
  relative(path: string): string {
    return relative(this.dir, path);
  }

  event(type: string, data: Record<string, unknown> = {}): number {
    const seq = ++this.seq;
    const line = `${JSON.stringify({ seq, ts: new Date().toISOString(), type, ...data })}\n`;
    this.enqueue(() => appendFile(this.eventsPath, line));
    return seq;
  }

  decide(d: Decision): void {
    const ts = new Date().toISOString();
    const seq = ++this.seq;
    this.rows++;
    const event = `${JSON.stringify({ seq, ts, type: 'decision', ...d })}\n`;
    const row = formatDecisionRow({ ts, event: seq, ...d });
    this.enqueue(async () => {
      await appendFile(this.eventsPath, event);
      await appendFile(this.decisionsPath, row);
    });
  }

  /** Writes a file the trail points at, such as `rubric.json`. */
  file(name: string, content: string): void {
    this.enqueue(() => writeFile(join(this.dir, name), content));
  }

  flush(): Promise<void> {
    return this.queue;
  }

  /**
   * Commits `decisions.tsv`, `dissent.json` and `synthesis.md` (those that exist) under `.concilium/runs/<run-id>/`
   * on the integration branch, as its last commit. `result.patch` was cut before, so it does not carry them.
   */
  async commit(input: { workspace: WorkspaceManager; repoDir: string; runId: string }): Promise<string | null> {
    await this.flush();
    try {
      const integration = await input.workspace.create({ repoDir: input.repoDir, runId: input.runId, candidateId: INTEGRATION_CANDIDATE });
      const target = join(integration.path, committedTrailDir(input.runId));
      await mkdir(target, { recursive: true });
      const files = COMMITTED_TRAIL_FILES.filter((name) => existsSync(join(this.dir, name)));
      for (const name of files) await copyFile(join(this.dir, name), join(target, name));
      const { headSha, committed } = await input.workspace.commit({
        repoDir: input.repoDir, runId: input.runId, candidateId: INTEGRATION_CANDIDATE,
        message: `concilium: decision trail for run ${input.runId}\n\n${files.map((f) => `${committedTrailDir(input.runId)}/${f}`).join('\n')}\n`,
      });
      if (!committed) throw new Error(`nothing to commit under ${committedTrailDir(input.runId)} (is it ignored?)`);
      this.event('trail-committed', { sha: headSha, files });
      await this.flush();
      return headSha;
    } catch (err) {
      const message = `could not commit the decision trail: ${err instanceof Error ? err.message : String(err)}`;
      log.error(message);
      this.errors.push(message);
      return null;
    }
  }
}

export type TrailCheck = { rows: number; events: number; problems: TrailProblem[] };

/**
 * The consistency check of a run directory: `decisions.tsv` against `events.jsonl` (see `auditTrail`), with
 * `file:` pointers resolved in the run directory and `commit:` pointers in the repo named by the `run-start` event.
 */
export async function checkTrail(runDir: string): Promise<TrailCheck> {
  const read = (name: string) => readFile(join(runDir, name), 'utf-8').catch(() => null);
  const [tsv, jsonl] = await Promise.all([read(DECISIONS_FILE), read(EVENTS_FILE)]);
  const missing = [...(tsv === null ? [DECISIONS_FILE] : []), ...(jsonl === null ? [EVENTS_FILE] : [])];
  if (tsv === null || jsonl === null) return { rows: 0, events: 0, problems: missing.map((f) => ({ line: 0, message: `${join(runDir, f)} does not exist` })) };

  const { events } = parseEvents(jsonl);
  const repoDir = events.find((e) => e.type === 'run-start')?.repoDir;
  const { rows } = parseDecisions(tsv);
  const resolved = new Set<string>();
  for (const pointer of trailPointers(rows)) {
    const [kind, ...rest] = pointer.split(':');
    const ref = rest.join(':');
    const ok = kind === 'file'
      ? !isAbsolute(ref) && existsSync(join(runDir, ref))
      : kind === 'commit' && typeof repoDir === 'string' && await commitExists(repoDir, ref);
    if (ok) resolved.add(pointer);
  }
  return { rows: rows.length, events: events.length, problems: auditTrail(tsv, jsonl, (p) => resolved.has(p)) };
}
