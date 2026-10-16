/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  CODE_TIMEOUT_MS,
  createConciliumRuntime,
  GitWorktreeWorkspace,
  isTaskType,
  JsonCodeRunStore,
  JsonConfigStore,
  JsonRunRepository,
  newRunId,
  parseRoleFlags,
  PlaintextSecretStore,
  roleWarnings,
  runCodeCandidates,
  specAgent,
  TASK_TYPES,
  VERIFY_CONFIG,
  type CandidateVerification,
  type CodeCandidate,
  type CodeFrame,
  type CodeRoleMap,
  type CodeRunRecord,
  type GateVerdict,
  type Graft,
  type Judgment,
} from '@concilium/core';
import { getConfigDir, getDataDir, getWorktreeRoot } from '../adapters/xdg-paths.js';
import { roleRows, tableLines } from '../formatters/roles.js';
import { collect } from './roles.js';

/** The exit code of a run that ended in `reframe-needed`: it finished, but needs the task restated before a patch. */
export const REFRAME_EXIT_CODE = 2;

interface CodeOptions {
  agents?: string;
  role?: string[];
  type?: string;
  cwd: string;
  includeDirty?: boolean;
  timeout?: string;
  verify: boolean;
  adversarial: boolean;
  judge: boolean;
  synthesis: boolean;
  json?: boolean;
}

/** The role table and its warnings. */
function roleLines(roles: CodeRoleMap): string[] {
  return ['Roles:', ...tableLines(roleRows(roles), '  '), ...roleWarnings(roles).map((w) => `Warning: ${w}`)];
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function frameLines({ taskType, rubric }: CodeFrame): string[] {
  const how = taskType.source === 'flag' ? 'from --type' : `classified: ${taskType.reason}`;
  const from = rubric.source === 'framer' ? `tailored by ${rubric.framer}` : `playbook defaults${rubric.note ? ` (${rubric.note})` : ''}`;
  return [`Type ${taskType.type} (${how})`, `Rubric ${rubric.criteria.length} criteria, ${from}, sha256 ${rubric.sha256.slice(0, 12)}`];
}

function verdict(v: CandidateVerification | null | undefined): string {
  if (v === undefined) return '-';
  if (v === null) return 'not checked';
  return v.disqualified ? 'DISQUALIFIED' : v.status;
}

function gateCell(gate: GateVerdict | undefined): string {
  if (!gate) return '-';
  if (gate.verdict === 'pass') return 'pass';
  return `${gate.outcome} (${gate.verdict === 'new-failure' ? 'new' : 'baseline'})`;
}

function printTable(rows: string[][], indent = '  '): void {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  for (const row of rows) console.log(`${indent}${row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd()}`);
}

function printVerification(record: CodeRunRecord): void {
  const run = record.verification;
  if (!run) {
    console.log('\n  Verification skipped (--no-verify)');
    return;
  }
  const from = run.plan.source === 'verify.yaml' ? VERIFY_CONFIG : 'detected';
  console.log(`\n  Gates (${from}, on the base and each candidate head; only new failures count):`);
  for (const note of [...run.plan.notes, ...run.errors]) console.log(`    ${note}`);
  if (run.plan.gates.length === 0) console.log('    none found');
  else {
    printTable([
      ['Gate', 'base', ...record.candidates.map((c) => c.candidateId)],
      ...run.plan.gates.map((gate) => [
        gate.name,
        run.baseline?.gates.find((g) => g.name === gate.name)?.outcome ?? '-',
        ...record.candidates.map((c) => gateCell(c.verification?.gates.find((g) => g.name === gate.name))),
      ]),
    ], '    ');
  }

  const findings = record.candidates.flatMap((c) => (c.verification?.integrity ?? []).map((f) => ({ candidateId: c.candidateId, ...f })));
  const installs = record.candidates.filter((c) => c.verification?.install && c.verification.install.outcome !== 'pass');
  const errors = record.candidates.flatMap((c) => (c.verification?.errors ?? []).map((e) => `${c.candidateId}: ${e}`));
  console.log(findings.length === 0 ? '\n  Integrity: no findings' : '\n  Integrity:');
  for (const f of findings) console.log(`    ${f.candidateId}: ${f.severity === 'disqualify' ? 'disqualified' : 'penalty'}, ${f.message}`);
  for (const c of installs) console.log(`    ${c.candidateId}: install (${c.verification!.install!.command}) ${c.verification!.install!.outcome}`);
  for (const error of errors) console.log(`    ${error}`);
}

function printAdversarial(record: CodeRunRecord): void {
  const round = record.adversarial;
  if (!round) {
    console.log('\n  Adversarial tests skipped (--no-adversarial)');
    return;
  }
  if (round.skipped) {
    console.log(`\n  Adversarial tests skipped: ${round.skipped}`);
    return;
  }
  const lanes = ['base', ...Object.keys(round.survival)];
  console.log(`\n  Adversarial tests (one adversary per family, run with \`${round.testCommand}\` on the base and each candidate):`);
  for (const a of round.adversaries) {
    const problems = [...a.errors, ...a.notes].map((e) => e.split('\n')[0]);
    console.log(`    ${a.lane} (${a.provider}): ${a.status}, ${round.tests.filter((t) => t.author === a.family).length} tests${problems.length ? `; ${problems.join('; ')}` : ''}`);
  }
  if (round.tests.length === 0) return;
  printTable([
    ['Test', 'Validity', ...lanes, 'Clause'],
    ...round.tests.map((t) => [t.id, t.validity, ...lanes.map((lane) => round.matrix[t.id]?.[lane] ?? '-'), t.specClause.length > 60 ? `${t.specClause.slice(0, 57)}...` : t.specClause]),
  ], '    ');
  console.log('\n  Survival (valid tests by other families):');
  for (const [candidateId, s] of Object.entries(round.survival)) {
    console.log(`    ${candidateId}: ${s.survived}/${s.counted}${s.failed.length ? `, failed ${s.failed.join(', ')}` : ''}`);
  }
}

function judgmentLine(j: Judgment): string {
  const who = j.judge ? `${j.judge}${j.sameFamily ? '' : ' (another family)'}` : 'no judge';
  return `Judge ${who} on ${j.candidates.join(', ')}: ${j.status}, ${j.reason}`;
}

function printRanking(record: CodeRunRecord): void {
  const { ranking } = record;
  console.log('\n  Ranking (disqualified last, then new gate failures, adversarial survival, integrity penalties; a judge orders exact ties, and the smallest diff breaks a tie left at the top):');
  printTable([
    ['Rank', 'Candidate', 'Report', 'New failures', 'Survival', 'Penalties', 'Judge'],
    ...ranking.order.map((e) => [
      String(e.rank),
      e.candidateId,
      e.key.disqualified ? `${e.status} (disqualified)` : e.status,
      String(e.key.newFailures),
      e.key.counted ? `${e.key.survived}/${e.key.counted}` : '-',
      String(e.key.penalties),
      e.judgeTotal === null ? '-' : String(e.judgeTotal),
    ]),
  ], '    ');
  for (const j of ranking.judgments) {
    console.log(`    ${judgmentLine(j)}`);
    if (j.sameFamily) console.log(`    Warning: same-family judge: ${j.sameFamilyReason}`);
  }
  console.log(ranking.winner ? `\n  Winner: ${ranking.winner} (${ranking.reason})` : `\n  No winner: ${ranking.reason.replace(/^no winner: /, '')}`);

  console.log('\n  Reports:');
  for (const c of record.candidates) {
    if (!c.report) continue;
    console.log(`    ${c.candidateId}: ${c.report.status} at ${c.report.headSha?.slice(0, 12) ?? 'no head'}, ${c.report.reason}`);
  }
}

function graftLine(g: Graft): string {
  return `${g.id} from ${g.candidateId} (${g.files.join(', ')}): ${g.status}${g.status === 'applied' ? ` at ${g.commitSha?.slice(0, 12)}` : `, ${g.reason}`}`;
}

function printSynthesis(record: CodeRunRecord): void {
  const s = record.synthesis;
  if (!s) {
    console.log('\n  Synthesis skipped (--no-synthesis)');
    return;
  }
  if (s.skipped) {
    console.log(`\n  Synthesis skipped: ${s.skipped}`);
    return;
  }
  console.log(`\n  Synthesis (base ${s.base!.candidateId}; grafts named by ${s.picker?.provider ?? 'no CLI'}, each re-verified with the gates and the valid adversarial tests):`);
  if (s.picker?.sameFamily) console.log(`    Warning: same-family graft picker: ${s.picker.sameFamilyReason}`);
  for (const g of s.grafts) console.log(`    ${graftLine(g)}`);
  if (s.grafts.length === 0) console.log('    no graft');
  for (const d of s.dropouts) console.log(`    dropout ${d.candidateId}: ${d.reason}`);
  for (const note of s.notes) console.log(`    ${note}`);
  console.log(`    Integration branch: ${s.branch ?? '-'}`);
  console.log(`    Patch: ${s.patchPath ?? '-'}`);
  console.log(`    Mergeable: ${s.mergeable ? 'yes' : 'no'}${s.mergeCheck ? `, git apply --check against HEAD ${s.mergeCheck.targetSha.slice(0, 12)}${s.mergeCheck.applies ? '' : `: ${s.mergeCheck.output.split('\n')[0]}`}` : ''}`);
  if (s.synthesisPath) console.log(`    Report: ${s.synthesisPath}`);
}

function printReframe(record: CodeRunRecord): void {
  const r = record.reframe;
  if (!r) return;
  console.log('\n  Reframe needed: the candidates diverge, so the task can be read more than one way. No patch was written.');
  for (const d of r.divergence) {
    console.log(`    ${d.trigger}: ${d.detail}`);
    for (const c of d.conflicts) console.log(`      "${c.clause}": ${c.evidence.join('; ')}`);
  }
  console.log(`\n  Questions (${r.source === 'phraser' ? `phrased by ${r.phraser}` : 'written from the evidence'}):`);
  r.questions.forEach((q, i) => console.log(`    ${i + 1}. On "${q.clause}": ${q.question}`));
  for (const note of r.notes) console.log(`    ${note}`);
  if (r.reportPath) console.log(`    Report: ${r.reportPath}`);
}

function summaryRows(candidates: CodeCandidate[]): string[][] {
  return [
    ['Candidate', 'Status', 'Verified', 'Files', '+/-', 'Commits', 'Duration', 'Tokens in/out', 'Branch'],
    ...candidates.map((c) => [
      c.candidateId,
      c.status,
      verdict(c.verification),
      c.diffStat ? String(c.diffStat.filesChanged) : '-',
      c.diffStat ? `+${c.diffStat.insertions}/-${c.diffStat.deletions}` : '-',
      c.diffStat ? String(c.diffStat.commits) : '-',
      formatDuration(c.durationMs),
      c.usage ? `${c.usage.inputTokens}/${c.usage.outputTokens}` : '-',
      c.branch,
    ]),
  ];
}

function printSummary(record: CodeRunRecord, savedTo: string | null): void {
  console.log(`\n  Run ${record.id} in ${record.repoDir}`);
  console.log(`  Base ${record.baseSha}${record.snapshotRef ? ` (dirty-tree snapshot of ${record.headSha})` : ''}`);
  for (const line of frameLines(record)) console.log(`  ${line}`);
  for (const line of roleLines(record.roles)) console.log(`  ${line}`);
  console.log();
  printTable(summaryRows(record.candidates));
  printVerification(record);
  printAdversarial(record);
  printRanking(record);
  printSynthesis(record);
  printReframe(record);

  const failed = record.candidates.filter((c) => c.errors.length > 0);
  if (failed.length > 0) {
    console.log('\n  Errors:');
    for (const c of failed) for (const error of c.errors) console.log(`    ${c.candidateId}: ${error.split('\n')[0]}`);
  }

  console.log('\n  Inspect:');
  for (const c of record.candidates.filter((c) => c.headSha)) {
    console.log(`    git -C ${record.repoDir} diff ${record.baseSha.slice(0, 12)}..${c.branch}`);
    console.log(`      worktree: ${c.worktree}`);
  }
  console.log(`\n  Clean up: concilium gc --run ${record.id}`);
  if (savedTo) console.log(`  Run saved: ${savedTo}`);
  console.log();
}

export function registerCodeCommand(program: Command): void {
  program
    .command('code')
    .description('Have agent CLIs write code, one git worktree each')
    .argument('[task...]', 'The coding task')
    .option('--agents <list>', 'Candidate agents, the implementer role (e.g. "claude,codex" or "claude:opus,codex:gpt-5.2-codex"); default: the installed, signed-in agent CLIs (see `concilium doctor`)')
    .option('--role <role=members>', 'Who plays a role: planner, implementer, adversary, judge or integrator, as cli[:model] (e.g. "judge=codex:gpt-5.2", "adversary=claude,gemini"); repeatable, and beats .concilium/factory.yaml and saved config (see `concilium roles`)', collect)
    .option('--type <type>', `Task type, which picks the playbook and default rubric: ${TASK_TYPES.join(', ')} (default: guessed from the task)`)
    .option('--cwd <path>', 'Directory of the git repo to work on', process.cwd())
    .option('--include-dirty', 'Start from the uncommitted changes too (snapshotted to a scratch ref) instead of refusing a dirty tree')
    .option('--timeout <minutes>', `Wall-clock limit per candidate and per adversary in minutes (default: ${CODE_TIMEOUT_MS / 60_000})`)
    .option('--no-verify', `Skip the gates (${VERIFY_CONFIG}, or the detected test, lint and typecheck commands) and the integrity checks after the candidates finish; also skips the adversarial tests`)
    .option('--no-adversarial', 'Skip the adversarial round, where one agent per family writes tests against the other candidates')
    .option('--no-judge', 'Do not ask a judge CLI (from another model family when one is usable) to order candidates tied on the evidence; a tie at the top goes to the smallest diff')
    .option('--no-synthesis', 'Do not graft ideas from the other candidates into the winner on the integration branch, and write no result.patch or synthesis.md; also skips the divergence check that ends a run in reframe-needed (exit 2)')
    .option('--json', 'Output the run record as JSON to stdout')
    .action(async (taskParts: string[], opts: CodeOptions) => {
      const fail = (message: string): never => {
        console.error(opts.json ? JSON.stringify({ error: message }) : `Error: ${message}`);
        process.exit(1);
      };

      const task = taskParts.join(' ').trim();
      if (!task) fail('No task provided. Use `concilium code "<task>"`.');
      const timeoutMinutes = opts.timeout === undefined ? undefined : Number(opts.timeout);
      if (timeoutMinutes !== undefined && !(timeoutMinutes > 0)) fail(`--timeout must be a positive number of minutes, got "${opts.timeout}"`);
      const type = opts.type === undefined || isTaskType(opts.type)
        ? opts.type
        : fail(`--type must be one of ${TASK_TYPES.join(', ')}, got "${opts.type}"`);

      const runtime = createConciliumRuntime({
        secretStore: new PlaintextSecretStore(),
        configStore: new JsonConfigStore(getConfigDir()),
        runRepository: new JsonRunRepository(getDataDir()),
      });

      // Progress goes to stderr so stdout holds only the summary or the JSON.
      const progress = (line: string) => !opts.json && console.error(line);
      let record: CodeRunRecord;
      let savedTo: string | null = null;
      try {
        const roleFlags = opts.role ?? [];
        if (opts.agents !== undefined && roleFlags.some((r) => r.split('=')[0].trim() === 'implementer')) {
          fail('--agents and --role implementer=... set the same role; use one');
        }
        const flags = parseRoleFlags([...(opts.agents !== undefined ? [`implementer=${opts.agents}`] : []), ...roleFlags]);
        if (flags.juror || flags.chairman) fail('juror and chairman are plan-council roles; set them with `concilium run --juror-models` and `--chairman`');
        const roles = await runtime.resolveCodeRoles({ repoDir: resolve(opts.cwd), flags });
        const agents = roles.implementer.value.map(specAgent);
        if (agents.length === 0) fail('no implementer to run');
        for (const line of roleLines(roles)) progress(`  ${line}`);

        const store = new JsonCodeRunStore(getDataDir());
        const runId = newRunId();
        record = await runCodeCandidates({
          task,
          runId,
          repoDir: resolve(opts.cwd),
          agents,
          roles,
          type,
          includeDirty: opts.includeDirty,
          timeoutMs: timeoutMinutes === undefined ? undefined : timeoutMinutes * 60_000,
          drivers: runtime.drivers,
          workspace: new GitWorktreeWorkspace({ root: getWorktreeRoot() }),
          onFramed: (frame) => frameLines(frame).forEach((line) => progress(`  ${line}`)),
          onCandidateStart: (c) => progress(`  ▶ ${c.candidateId}: running in ${c.worktree}`),
          onCandidateDone: (c) => progress(`  ${c.status === 'ok' ? '✓' : '✗'} ${c.candidateId}: ${c.status} in ${formatDuration(c.durationMs)}`),
          verify: opts.verify,
          onGateDone: (lane, gate) => progress(`  ${gate.outcome === 'pass' ? '✓' : '✗'} ${lane} gate ${gate.name}: ${gate.outcome} in ${formatDuration(gate.durationMs)}`),
          adversarial: opts.adversarial,
          onAdversaryDone: (a) => progress(`  ${a.status === 'ok' ? '✓' : '✗'} ${a.lane}: ${a.status} in ${formatDuration(a.durationMs)}`),
          onTestDone: (testId, lane, cell) => progress(`  ${cell === 'pass' ? '✓' : '✗'} ${testId} on ${lane}: ${cell}`),
          judge: opts.judge,
          onJudgeDone: (j) => {
            progress(`  ${j.status === 'PASS' ? '✓' : '✗'} ${judgmentLine(j)}`);
            if (j.sameFamily) progress(`  Warning: same-family judge: ${j.sameFamilyReason}`);
          },
          // result.patch and synthesis.md go next to run.json.
          synthesis: opts.synthesis ? { runDir: store.runDir(runId) } : undefined,
          onGraftDone: (g) => progress(`  ${g.status === 'applied' ? '✓' : '✗'} ${graftLine(g)}`),
        });
        savedTo = await store.save(record).catch((err: Error) => {
          console.error(`Warning: could not save the run record: ${err.message}`);
          return null;
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }

      if (record.reframe) progress(`  ✗ reframe needed: ${record.reframe.questions.length} questions${record.reframe.reportPath ? ` in ${record.reframe.reportPath}` : ''}`);
      if (opts.json) console.log(JSON.stringify(record, null, 2));
      else printSummary(record, savedTo);
      if (record.candidates.every((c) => c.status !== 'ok')) process.exitCode = 1;
      else if (record.status === 'reframe-needed') process.exitCode = REFRAME_EXIT_CODE;
    });
}
