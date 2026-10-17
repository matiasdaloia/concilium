/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { execFile } from 'node:child_process';
import { mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('action-gate');

/**
 * The only module that may build a `git push` or a `gh` command (a repo invariant checks it). Every orchestrator
 * side effect that could leave the run's own worktrees, `concilium/` branches and run store goes through `ActionGate`.
 */

export const GATES_JSON = 'gates.json';
export const GATES_MD = 'gates.md';
const LOCK_FILE = 'gates.lock';
/** Characters of a command's output kept on its gate: the end, where errors are reported. */
export const GATE_OUTPUT_LIMIT = 4000;

/** B10: proceed, proceed and announce, always pause. */
export type AutonomyTier = 'proceed' | 'proceed-and-announce' | 'always-pause';

export type ActionKind =
  // Proceed.
  | 'worktree'
  | 'branch'
  | 'run-cli'
  | 'gate'
  | 'store-write'
  | 'revert'
  | 'gc'
  // Proceed and announce.
  | 'install'
  | 'rebase'
  // Always pause.
  | 'push'
  | 'pr'
  | 'write-checkout'
  | 'delete'
  | 'deploy'
  | 'message';

export type ActionRequest = {
  kind: ActionKind;
  /** The exact argv, run without a shell. */
  command: string[];
  cwd: string;
  /** The branch or ref a `branch` or `delete` action touches. */
  ref?: string;
  /** Why the orchestrator wants it, for the gate entry. */
  reason?: string;
  /**
   * What a paused action is for, such as the commit it ships. A keyed request reuses a pending, approved or executed
   * gate of its kind with the same key, command and cwd, and supersedes every other pending keyed gate of its kind.
   */
  key?: string;
};

/** `superseded`: a newer keyed request of its kind replaced it while pending; it can never run. */
export type GateStatus = 'pending' | 'approved' | 'executed' | 'failed' | 'rejected' | 'superseded';

export type GateEntry = {
  id: string;
  runId: string;
  kind: ActionKind;
  command: string[];
  cwd: string;
  reason: string;
  /** The request's `key`, or null (absent on gates written before keys existed). */
  key?: string | null;
  requestedAt: string;
  status: GateStatus;
  /** When it was approved, rejected or superseded. */
  decidedAt: string | null;
  executedAt: string | null;
  exitCode: number | null;
  output: string | null;
};

export type GatesFile = { version: 1; runId: string; gates: GateEntry[] };

export type CommandResult = { exitCode: number; output: string };

export type ActionOutcome =
  | { tier: 'proceed' | 'proceed-and-announce'; reason: string; result: CommandResult }
  | { tier: 'always-pause'; reason: string; gate: GateEntry; reused: boolean; superseded: GateEntry[] };

/** A keyed gate in these states is the same request again; a failed or rejected one is asked for anew. */
const REUSABLE: readonly GateStatus[] = ['pending', 'approved', 'executed'];

const TIERS: Record<ActionKind, AutonomyTier> = {
  worktree: 'proceed',
  branch: 'proceed',
  'run-cli': 'proceed',
  gate: 'proceed',
  'store-write': 'proceed',
  revert: 'proceed',
  gc: 'proceed',
  install: 'proceed-and-announce',
  rebase: 'proceed-and-announce',
  push: 'always-pause',
  pr: 'always-pause',
  'write-checkout': 'always-pause',
  delete: 'always-pause',
  deploy: 'always-pause',
  message: 'always-pause',
};

const PAUSE_REASONS: Partial<Record<ActionKind, string>> = {
  push: 'pushes to a remote',
  pr: 'opens, merges or closes a pull request',
  'write-checkout': "writes to the user's checkout",
  deploy: 'deploys',
  message: 'sends a message to a person',
};

/** A ref Concilium owns: a `concilium/` branch or a `refs/concilium/` scratch ref. */
export function isConciliumRef(ref: string): boolean {
  return /^(refs\/heads\/)?concilium\/|^refs\/concilium\//.test(ref) && !ref.split('/').includes('..');
}

/** The B10 tier of an action, with the reason. A `branch` or `delete` outside `concilium/` pauses. */
export function classifyAction(action: Pick<ActionRequest, 'kind' | 'ref'>): { tier: AutonomyTier; reason: string } {
  if (action.kind === 'branch' || action.kind === 'delete') {
    if (action.ref !== undefined && isConciliumRef(action.ref)) return { tier: 'proceed', reason: `${action.ref} is a concilium/ ref` };
    const what = action.kind === 'branch' ? 'writes' : 'deletes';
    return { tier: 'always-pause', reason: action.ref ? `${what} ${action.ref}, outside concilium/` : `${what} something outside the run's own worktrees and branches` };
  }
  const tier = TIERS[action.kind];
  return { tier, reason: PAUSE_REASONS[action.kind] ?? `${action.kind} is ${tier === 'proceed' ? 'reversible and stays in the run' : 'announced'}` };
}

/** `git push <remote> <refspec>`, for a `push` request. */
export function gitPushCommand(remote: string, refspec: string): string[] {
  return ['git', 'push', remote, refspec];
}

/** `gh pr create` from `head` with the body read from `bodyFile`, for a `pr` request. Without `base`, gh uses the default branch. */
export function ghPrCreateCommand(pr: { head: string; title: string; bodyFile: string; base?: string | null; draft?: boolean }): string[] {
  return ['gh', 'pr', 'create', '--head', pr.head, '--title', pr.title, '--body-file', pr.bodyFile, ...(pr.base ? ['--base', pr.base] : []), ...(pr.draft ? ['--draft'] : [])];
}

/** A command as one shell line, each argument quoted when it needs it. */
export function shellLine(command: string[]): string {
  return command.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ');
}

function runCommand(command: string[], cwd: string): Promise<CommandResult> {
  const [file, ...args] = command;
  return new Promise((resolve) => {
    execFile(file, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.slice(-GATE_OUTPUT_LIMIT);
      if (!err) return resolve({ exitCode: 0, output });
      const code = (err as { code?: unknown }).code;
      resolve({ exitCode: typeof code === 'number' ? code : 1, output: output || err.message });
    });
  });
}

/** `gates.md`: every gate of a run, pending first, with its exact command and how to approve or reject it. */
export function gatesMarkdown(file: GatesFile): string {
  const order = (g: GateEntry) => (g.status === 'pending' ? 0 : 1);
  const lines = [`# Gates of run ${file.runId}`, '', 'Each paused action runs only on its own `concilium approve <gate-id>`. An approval never covers another gate.', ''];
  for (const g of [...file.gates].sort((a, b) => order(a) - order(b))) {
    lines.push(`## ${g.id}: ${g.status}`, '', `- kind: ${g.kind}`, `- reason: ${g.reason}`, `- requested: ${g.requestedAt}`, `- cwd: ${g.cwd}`);
    if (g.decidedAt) lines.push(`- decided: ${g.decidedAt}`);
    if (g.executedAt) lines.push(`- executed: ${g.executedAt} (exit ${g.exitCode})`);
    lines.push('', '```sh', shellLine(g.command), '```', '');
    if (g.status === 'pending') lines.push(`Approve: \`concilium approve ${g.id}\`. Reject: \`concilium reject ${g.id}\`.`, '');
  }
  return lines.join('\n');
}

async function readGates(runDir: string, runId: string): Promise<GatesFile> {
  try {
    return JSON.parse(await readFile(join(runDir, GATES_JSON), 'utf8')) as GatesFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, runId, gates: [] };
    throw err;
  }
}

async function writeGates(runDir: string, file: GatesFile): Promise<void> {
  await writeFile(join(runDir, GATES_JSON), JSON.stringify(file, null, 2) + '\n', 'utf8');
  await writeFile(join(runDir, GATES_MD), gatesMarkdown(file), 'utf8');
}

/** Runs `fn` holding the run's gate lock, so two processes never both approve one gate. */
async function withLock<T>(runDir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, LOCK_FILE);
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 50) {
        throw new Error(`the gates of ${runDir} are locked (${path}); remove it if no concilium process is running`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}

/** Enforces B10 for one run: runs proceed actions, announces the rest, and writes always-pause actions as gates. */
export class ActionGate {
  constructor(
    private readonly options: { runId: string; runDir: string; onAnnounce?: (notice: string) => void; now?: () => Date },
  ) {}

  async request(action: ActionRequest): Promise<ActionOutcome> {
    if (action.command.length === 0) throw new Error('an action needs a command');
    const { tier, reason } = classifyAction(action);
    if (tier !== 'always-pause') {
      if (tier === 'proceed-and-announce') this.options.onAnnounce?.(`${action.kind}: ${shellLine(action.command)} (in ${action.cwd})`);
      log.debug(`${tier}: ${shellLine(action.command)} in ${action.cwd}`);
      return { tier, reason, result: await runCommand(action.command, action.cwd) };
    }

    const { runId, runDir } = this.options;
    const now = (this.options.now?.() ?? new Date()).toISOString();
    const { gate, reused, superseded } = await withLock(runDir, async () => {
      const file = await readGates(runDir, runId);
      const keyed = action.key === undefined ? [] : file.gates.filter((g) => g.kind === action.kind && g.key != null);
      const same = keyed.find(
        (g) => g.key === action.key && g.cwd === action.cwd && REUSABLE.includes(g.status) && JSON.stringify(g.command) === JSON.stringify(action.command),
      );
      if (same) return { gate: same, reused: true, superseded: [] };
      const superseded = keyed.filter((g) => g.status === 'pending');
      for (const g of superseded) {
        g.status = 'superseded';
        g.decidedAt = now;
      }
      const entry: GateEntry = {
        id: `${runId}-g${file.gates.length + 1}`,
        runId,
        kind: action.kind,
        command: [...action.command],
        cwd: action.cwd,
        reason: action.reason ? `${action.reason} (${reason})` : reason,
        key: action.key ?? null,
        requestedAt: now,
        status: 'pending',
        decidedAt: null,
        executedAt: null,
        exitCode: null,
        output: null,
      };
      file.gates.push(entry);
      await writeGates(runDir, file);
      return { gate: entry, reused: false, superseded };
    });
    for (const g of superseded) log.info(`superseded ${g.id} by ${gate.id}`);
    log.info(`${reused ? 'reused' : 'paused'} ${gate.id}: ${shellLine(gate.command)} (${gate.reason})`);
    return { tier, reason, gate, reused, superseded };
  }
}

/** Every run dir under `runsDir` that has gates, or only `runId`'s. */
export async function listGates(runsDir: string, runId?: string): Promise<GateEntry[]> {
  let ids: string[];
  if (runId) ids = [runId];
  else {
    try {
      ids = (await readdir(runsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
  const all = await Promise.all(ids.map(async (id) => (await readGates(join(runsDir, id), id)).gates));
  return all.flat();
}

async function decide(runsDir: string, gateId: string, apply: (entry: GateEntry, runDir: string, file: GatesFile) => Promise<void>): Promise<GateEntry> {
  const found = (await listGates(runsDir)).find((g) => g.id === gateId);
  if (!found) throw new Error(`no gate ${gateId}`);
  const runDir = join(runsDir, found.runId);
  return withLock(runDir, async () => {
    const file = await readGates(runDir, found.runId);
    const entry = file.gates.find((g) => g.id === gateId)!;
    if (entry.status === 'superseded') throw new Error(`gate ${gateId} is superseded by a newer request; see concilium gates`);
    if (entry.status !== 'pending') throw new Error(`gate ${gateId} is ${entry.status}; each gate is decided once`);
    await apply(entry, runDir, file);
    return entry;
  });
}

/**
 * Approves one pending gate and runs its exact command in its cwd. It is marked `approved` before the command runs,
 * so it never runs twice, then `executed` or `failed` with the exit code and the end of the output.
 */
export function approveGate(runsDir: string, gateId: string, now: () => Date = () => new Date()): Promise<GateEntry> {
  return decide(runsDir, gateId, async (entry, runDir, file) => {
    entry.status = 'approved';
    entry.decidedAt = now().toISOString();
    await writeGates(runDir, file);
    log.info(`approved ${entry.id}: ${shellLine(entry.command)}`);
    const result = await runCommand(entry.command, entry.cwd);
    entry.status = result.exitCode === 0 ? 'executed' : 'failed';
    entry.executedAt = now().toISOString();
    entry.exitCode = result.exitCode;
    entry.output = result.output;
    await writeGates(runDir, file);
  });
}

/** Rejects one pending gate; its command never runs. */
export function rejectGate(runsDir: string, gateId: string, now: () => Date = () => new Date()): Promise<GateEntry> {
  return decide(runsDir, gateId, async (entry, runDir, file) => {
    entry.status = 'rejected';
    entry.decidedAt = now().toISOString();
    await writeGates(runDir, file);
  });
}
