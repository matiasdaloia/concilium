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
  PlaintextSecretStore,
  prStatus,
  requestPr,
  shellLine,
  verifyPr,
  type CodeRunRecord,
  type PrVerdict,
} from '@concilium/core';
import { getConfigDir, getDataDir } from '../adapters/xdg-paths.js';

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
  const by = v.verifier ? `${v.verifier.provider} (${v.verifier.family})` : 'no verifier';
  return `Verdict: ${v.verdict} at ${v.headSha?.slice(0, 12) ?? 'no head'} (base ${v.baseSha.slice(0, 12)}, patch-id ${v.patchId?.slice(0, 12) ?? 'none'}) by ${by}: ${v.reason}`;
}

/** Re-verifies the run's integration branch, saves the verdict on the record and prints it. */
async function verify(store: JsonCodeRunStore, record: CodeRunRecord): Promise<PrVerdict> {
  const runtime = createConciliumRuntime({
    secretStore: new PlaintextSecretStore(),
    configStore: new JsonConfigStore(getConfigDir()),
    runRepository: new JsonRunRepository(getDataDir()),
  });
  const verdict = await verifyPr({ record, runDir: store.runDir(record.id), drivers: runtime.drivers, onStep: (line) => console.error(`  ${line}`) });
  record.prVerdict = verdict;
  await store.save(record);
  console.log(verdictLine(verdict));
  for (const note of verdict.notes) console.log(`  note: ${note}`);
  console.log(`Report: ${verdict.reportPath}`);
  return verdict;
}

const passed = (v: PrVerdict) => v.verdict === 'PASS' || v.verdict === 'PASS+NOTES';

export function registerPrCommands(program: Command): void {
  program
    .command('pr')
    .description('Verify a run, then pause its push and pull request')
    .argument('<run-id>', 'The code run whose integration branch to ship')
    .option('--remote <name>', 'The remote to push to', 'origin')
    .option('--base <branch>', "The pull request's base branch (default: the remote's default branch)")
    .action(async (runId: string, opts: { remote: string; base?: string }) => {
      const store = new JsonCodeRunStore(getDataDir());
      const record = await loadRun(store, runId);
      if (!record.synthesis?.branch) fail(`run ${runId} has no integration branch to ship`);
      try {
        const verdict = await verify(store, record);
        const { pr, gates } = await requestPr({ record, runDir: store.runDir(runId), verdict, remote: opts.remote, base: opts.base });
        record.pr = pr;
        await store.save(record);
        console.log(`PR body: ${pr.bodyPath}${pr.draft ? ' (a draft: the verdict is not a pass)' : ''}`);
        console.log('Paused; nothing is pushed or opened until you approve:');
        for (const g of gates) console.log(`  ${g.id}  ${g.kind}  ${shellLine(g.command)}`);
        console.log('Approve in order:');
        for (const g of gates) console.log(`  concilium approve ${g.id}`);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('verify-pr')
    .description('Verify a run from a family that wrote none of it')
    .argument('<run-id>', 'The code run to verify')
    .action(async (runId: string) => {
      const store = new JsonCodeRunStore(getDataDir());
      const record = await loadRun(store, runId);
      try {
        if (!passed(await verify(store, record))) process.exitCode = 1;
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
        console.log(`Run ${runId}: ${record.synthesis?.branch ?? 'no integration branch'} at ${status.heads.local?.slice(0, 12) ?? 'nothing'}`);
        if (record.pr) console.log(`Pushed branch: ${record.pr.remote}/${record.pr.remoteBranch} at ${status.heads.remote?.slice(0, 12) ?? 'unknown here'}`);
        if (!status.verdict) console.log('Verdict: none; run `concilium verify-pr` or `concilium pr`');
        else console.log(`${verdictLine(status.verdict)}\n  ${status.state!.valid ? 'valid' : status.state!.reason}`);
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
