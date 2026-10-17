/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { join } from 'node:path';
import type { Command } from 'commander';
import {
  checkRoleFamilies,
  createConciliumRuntime,
  JsonCodeRunStore,
  JsonConfigStore,
  JsonRunRepository,
  loadFactory,
  parseCommandRoles,
  PlaintextSecretStore,
  prStatus,
  requestPr,
  sameFamilyWarning,
  shellLine,
  shipSource,
  throwOnRoleErrors,
  verifierSpec,
  verifyPr,
  type CodeRunRecord,
  type PrVerdict,
} from '@concilium/core';
import { getConfigDir, getDataDir } from '../adapters/xdg-paths.js';
import { factoryLines } from '../formatters/factory.js';
import { printError, violationLines } from '../formatters/roles.js';
import { collect } from './roles.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What `--allow-same-family-verifier` says, shared by every command that verifies. */
export const ALLOW_SAME_FAMILY_HELP =
  'Let a configured verifier of an author family verify; the verdict is flagged same-family and the PR is a draft (default: factory.yaml, saved config, else no)';

interface VerifyOptions {
  role?: string[];
  allowSameFamilyVerifier?: boolean;
}

function fail(err: unknown): never {
  printError(err);
  process.exit(1);
}

async function loadRun(store: JsonCodeRunStore, runId: string): Promise<CodeRunRecord> {
  if (!RUN_ID.test(runId)) fail(`invalid run id "${runId}"`);
  try {
    return await store.load(runId);
  } catch {
    fail(`no code run ${runId} in ${store.runDir(runId)}`);
  }
}

function verdictLine(v: PrVerdict): string {
  const by = v.verifier ? `${verifierSpec(v.verifier)} (${v.verifier.family ?? 'unknown family'})${v.verifier.sameFamily ? ', same family' : ''}` : 'no verifier';
  return `Verdict: ${v.verdict} at ${v.headSha?.slice(0, 12) ?? 'no commit'} (base ${v.baseSha.slice(0, 12)}, patch-id ${v.patchId?.slice(0, 12) ?? 'none'}) by ${by}: ${v.reason}`;
}

/** The verdict, a same-family warning and the notes, one per line. */
function verdictLines(v: PrVerdict): string[] {
  const warning = sameFamilyWarning(v);
  return [verdictLine(v), ...(warning ? [`Warning: ${warning}`] : []), ...v.notes.map((n) => `  note: ${n}`)];
}

/**
 * Re-verifies the commit the run would ship, saves the verdict on the record and prints it. The role rules run
 * first, against the run's author families: an error stops before any agent CLI runs.
 */
async function verify(command: 'pr' | 'verify-pr', store: JsonCodeRunStore, record: CodeRunRecord, opts: VerifyOptions): Promise<PrVerdict> {
  const flags = parseCommandRoles(command, { roles: opts.role ?? [] });
  const runtime = createConciliumRuntime({
    secretStore: new PlaintextSecretStore(),
    configStore: new JsonConfigStore(getConfigDir()),
    runRepository: new JsonRunRepository(getDataDir()),
  });
  const verifier = await runtime.resolveVerifier({ repoDir: record.repoDir, flags, allowSameFamily: opts.allowSameFamilyVerifier });
  const source = shipSource(record);
  const authors = 'blocked' in source ? undefined : source.authorFamilies;
  for (const line of violationLines(throwOnRoleErrors(checkRoleFamilies({ verifier, authors })))) console.error(line);
  const verdict = await verifyPr({
    record, runDir: store.runDir(record.id), drivers: runtime.drivers, verifier: verifier.value, allowSameFamily: verifier.allowSameFamily.value,
    onStep: (line) => console.error(`  ${line}`),
  });
  record.prVerdict = verdict;
  await store.save(record);
  for (const line of verdictLines(verdict)) console.log(line);
  console.log(`Report: ${verdict.reportPath}`);
  return verdict;
}

const passed = (v: PrVerdict) => v.verdict === 'PASS' || v.verdict === 'PASS+NOTES';

export function registerPrCommands(program: Command): void {
  program
    .command('pr')
    .description('Verify a run, then pause its push and its PR')
    .argument('<run-id>', 'The code run to ship: its integration branch, or its only candidate')
    .option('--remote <name>', 'The remote to push to', 'origin')
    .option('--base <branch>', "The pull request's base branch (default: the remote's default branch)")
    .option('--role <role=member>', 'The verifier, as verifier=<cli[:model]> (default: factory.yaml, saved config, else auto)', collect)
    .option('--allow-same-family-verifier', ALLOW_SAME_FAMILY_HELP)
    .action(async (runId: string, opts: VerifyOptions & { remote: string; base?: string }) => {
      const store = new JsonCodeRunStore(getDataDir());
      const record = await loadRun(store, runId);
      const source = shipSource(record);
      if ('blocked' in source) fail(`run ${runId} has nothing to ship: ${source.blocked}`);
      try {
        const verdict = await verify('pr', store, record, opts);
        const { pr, gates, reused, superseded } = await requestPr({ record, runDir: store.runDir(runId), verdict, remote: opts.remote, base: opts.base });
        record.pr = pr;
        await store.save(record);
        console.log(`PR body: ${pr.bodyPath}${pr.draftReason ? ` (a draft: ${pr.draftReason})` : ''}`);
        for (const g of superseded) console.log(`Superseded ${g.id} (${g.kind}): it was for another commit or command and can no longer run`);
        console.log(reused
          ? `Already paused for ${pr.sha.slice(0, 12)}; no new gates:`
          : `Paused; nothing is pushed or opened until you approve. The push sends ${pr.sha.slice(0, 12)} exactly:`);
        for (const g of gates) console.log(`  ${g.id}  ${g.status}  ${g.kind}  ${shellLine(g.command)}`);
        const pending = gates.filter((g) => g.status === 'pending');
        if (pending.length > 0) {
          console.log('Approve in order:');
          for (const g of pending) console.log(`  concilium approve ${g.id}`);
        }
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('verify-pr')
    .description('Verify the commit a run would ship')
    .argument('<run-id>', 'The code run to verify')
    .option('--role <role=member>', 'The verifier, as verifier=<cli[:model]> (default: factory.yaml, saved config, else auto)', collect)
    .option('--allow-same-family-verifier', ALLOW_SAME_FAMILY_HELP)
    .action(async (runId: string, opts: VerifyOptions) => {
      const store = new JsonCodeRunStore(getDataDir());
      const record = await loadRun(store, runId);
      try {
        if (!passed(await verify('verify-pr', store, record, opts))) process.exitCode = 1;
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('status')
    .description("Show a run's gates and verdict")
    .argument('<run-id>', 'The code run, or a factory run: its tasks, runs and verdicts')
    .action(async (runId: string) => {
      const store = new JsonCodeRunStore(getDataDir());
      if (!RUN_ID.test(runId)) fail(`invalid run id "${runId}"`);
      const factory = await loadFactory(store.runDir(runId)).catch(fail);
      if (factory) {
        for (const line of factoryLines(factory, store.runDir(runId))) console.log(line);
        return;
      }
      const record = await loadRun(store, runId);
      try {
        const status = await prStatus(record, join(getDataDir(), 'runs'));
        console.log(`Run ${runId}: ${status.branch ?? 'nothing to ship'} at ${status.heads.local?.slice(0, 12) ?? 'nothing'}`);
        if (record.pr) console.log(`Pushed branch: ${record.pr.remote}/${record.pr.remoteBranch} at ${status.heads.remote?.slice(0, 12) ?? 'unknown here'}`);
        if (!status.verdict) console.log('Verdict: none; run `concilium verify-pr` or `concilium pr`');
        else {
          for (const line of verdictLines(status.verdict)) console.log(line);
          console.log(`  ${status.state!.valid ? 'valid' : status.state!.reason}`);
        }
        if (status.gates.length === 0) console.log('Gates: none');
        else {
          console.log('Gates:');
          for (const g of status.gates) console.log(`  ${g.id}  ${g.status}  ${g.kind}  ${shellLine(g.command)}`);
        }
      } catch (err) {
        fail(err);
      }
    });
}
