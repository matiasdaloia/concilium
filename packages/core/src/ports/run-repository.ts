import type { RunRecord } from '../domain/run/run-record.js';

export interface RunSummary {
  id: string;
  createdAt: string;
  promptPreview: string;
  status: string;
}

export interface RunRepository {
  save(run: RunRecord): Promise<string>;
  load(id: string): Promise<RunRecord>;
  list(): Promise<RunSummary[]>;
  loadAll(): Promise<RunRecord[]>;
}
