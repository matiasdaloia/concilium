/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { join } from 'node:path';
import type { Command } from 'commander';
import {
  createConciliumRuntime,
  JsonCodeRunStore,
  JsonConfigStore,
  JsonRunRepository,
  parseRoleFlags,
  PlaintextSecretStore,
  prStatus,
  requestPr,
  sameFamilyWarning,
  shellLine,
  shipSource,
  verifierSpec,
  verifyPr,
  type CodeRunRecord,
  type PrVerdict,
} from '@concilium/core';
import { getConfigDir, getDataDir } from '../adapters/xdg-paths.js';
import { collect } from './roles.js';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

function fail(err: unknown): never {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
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

/** Re-verifies the commit the run would ship, saves the verdict on the record and prints it. */
async function verify(store: JsonCodeRunStore, record: CodeRunRecord, roleFlags: string[]): Promise<PrVerdict> {
  const flags = parseRoleFlags(roleFlags);
  const other = Object.keys(flags).filter((role) => role !== 'verifier');
  if (other.length > 0) throw new Error(`only --role verifier=<cli[:model]> applies here, not ${other.join(', ')}`);
  const runtime = createConciliumRuntime({
    secretStore: new PlaintextSecretStore(),
    configStore: new JsonConfigStore(getConfigDir()),
    runRepository: new JsonRunRepository(getDataDir()),
  });
  const verifier = await runtime.resolveVerifier({ repoDir: record.repoDir, flags });
  const verdict = await verifyPr({
    record, runDir: store.runDir(record.id), drivers: runtime.drivers, verifier: verifier.value, onStep: (line) => console.error(`  ${line}`),
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
    .action(async (runId: string, opts: { remote: string; base?: string; role?: string[] }) => {
      const store = new JsonCodeRunStore(getDataDir());
      const record = await loadRun(store, runId);
      const source = shipSource(record);
      if ('blocked' in source) fail(`run ${runId} has nothing to ship: ${source.blocked}`);
      try {
        const verdict = await verify(store, record, opts.role ?? []);
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
    .action(async (runId: string, opts: { role?: string[] }) => {
      const store = new JsonCodeRunStore(getDataDir());
      const record = await loadRun(store, runId);
      try {
        if (!passed(await verify(store, record, opts.role ?? []))) process.exitCode = 1;
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('status')
    .description("Show a run's gates and verdict")
    .argument('<run-id>', 'The code run')
    .action(async (runId: string) => {
      const store = new JsonCodeRunStore(getDataDir());
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
