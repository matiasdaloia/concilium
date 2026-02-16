import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunRecord } from '../domain/run/run-record.js';
import type { RunRepository, RunSummary } from '../ports/run-repository.js';
import type { ParsedEvent } from '../domain/agent/parsed-event.js';

function extractFinalTokenUsage(events: ParsedEvent[]): ParsedEvent | null {
  if (!events || events.length === 0) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost: number | null = null;

  for (const ev of events) {
    if (!ev.tokenUsage) continue;
    if (ev.tokenUsageCumulative) {
      inputTokens = ev.tokenUsage.inputTokens;
      outputTokens = ev.tokenUsage.outputTokens;
      totalCost = ev.tokenUsage.totalCost ?? null;
    } else {
      inputTokens += ev.tokenUsage.inputTokens;
      outputTokens += ev.tokenUsage.outputTokens;
      const prevCost: number = totalCost ?? 0;
      const evtCost: number = ev.tokenUsage.totalCost ?? 0;
      totalCost = (prevCost + evtCost) > 0 ? prevCost + evtCost : null;
    }
  }

  if (inputTokens === 0 && outputTokens === 0 && totalCost === null) return null;

  return {
    eventType: 'status',
    text: '',
    rawLine: '',
    tokenUsage: { inputTokens, outputTokens, totalCost },
    tokenUsageCumulative: true,
  };
}

export class JsonRunRepository implements RunRepository {
  constructor(private readonly dataDir: string) {}

  private get runsDir(): string {
    return join(this.dataDir, 'runs');
  }

  private async ensureRunsDir(): Promise<string> {
    const dir = this.runsDir;
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async save(run: RunRecord): Promise<string> {
    const dir = await this.ensureRunsDir();
    const filePath = join(dir, `${run.id}.json`);
    await writeFile(filePath, JSON.stringify(run), 'utf-8');
    return filePath;
  }

  async load(id: string): Promise<RunRecord> {
    const dir = await this.ensureRunsDir();
    const filePath = join(dir, `${id}.json`);
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data);
  }

  async loadAll(): Promise<RunRecord[]> {
    const dir = await this.ensureRunsDir();
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }

    const BATCH_SIZE = 20;
    const records: RunRecord[] = [];

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (file) => {
          const data: RunRecord = JSON.parse(
            await readFile(join(dir, file), 'utf-8'),
          );
          return {
            ...data,
            agents: data.agents.map(agent => {
              const { rawOutput: _raw, events, ...rest } = agent;
              const usage = extractFinalTokenUsage(events);
              return {
                ...rest,
                rawOutput: undefined,
                events: usage ? [usage] : [],
              } as typeof agent;
            }),
          };
        }),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          records.push(result.value);
        }
      }
    }

    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records;
  }

  async list(): Promise<RunSummary[]> {
    const dir = await this.ensureRunsDir();
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }

    const records: RunSummary[] = [];

    for (const file of files) {
      try {
        const data: RunRecord = JSON.parse(
          await readFile(join(dir, file), 'utf-8'),
        );
        let status: string;
        if (data.agents.every((a) => a.status === 'success')) {
          status = 'success';
        } else if (data.agents.some((a) => a.status === 'running')) {
          status = 'running';
        } else if (data.agents.some((a) => a.status === 'error')) {
          status = 'partial_error';
        } else {
          status = 'mixed';
        }
        records.push({
          id: data.id,
          createdAt: data.createdAt,
          promptPreview: data.prompt.slice(0, 70),
          status,
        });
      } catch {
        continue;
      }
    }

    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records;
  }
}
