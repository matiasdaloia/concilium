/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import TitleBar from '../components/TitleBar';
import Badge from '../components/Badge';
import MarkdownRenderer from '../components/MarkdownRenderer';
import { RANKING_COLUMNS, rankCells, type RunView } from '../../shared/run-view';

type BadgeVariant = 'green' | 'blue' | 'amber' | 'red' | 'muted';

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  PASS: 'green', 'PASS+NOTES': 'green', ok: 'green', done: 'green', pass: 'green', applied: 'green', resolved: 'green',
  ISSUES: 'amber', 'reframe-needed': 'amber', warning: 'amber', 'accepted-risk': 'amber', overruled: 'blue',
  BLOCKED: 'red', FAIL: 'red', fail: 'red', error: 'red', rejected: 'red', open: 'red',
};

function Status({ value }: { value: string | null }) {
  if (!value) return <span className="text-text-muted">-</span>;
  return <Badge variant={STATUS_VARIANT[value] ?? 'muted'}>{value}</Badge>;
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 12) : '-';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-bg-surface border border-border-primary rounded-lg p-4">
      <h3 className="text-[10px] text-text-muted uppercase tracking-wider mb-3">{title}</h3>
      {children}
    </section>
  );
}

function Table({ head, children }: { head: readonly string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] font-mono text-left">
        <thead>
          <tr className="text-text-tertiary border-b border-border-primary">
            {head.map((h) => <th key={h} className="py-1.5 pr-4 font-medium whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody className="text-text-secondary">{children}</tbody>
      </table>
    </div>
  );
}

const cell = 'py-1.5 pr-4 align-top';

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-mono text-text-muted">{children}</p>;
}

function RankingSection({ run }: { run: RunView }) {
  if (!run.ranking) return <Section title="Ranking"><Empty>No ranking in this run directory.</Empty></Section>;
  return (
    <Section title="Ranking">
      <Table head={RANKING_COLUMNS}>
        {run.ranking.rows.map((row) => (
          <tr key={row.candidateId} data-ranking-row className="border-b border-border-secondary">
            {rankCells(row).map((value, i) => <td key={RANKING_COLUMNS[i]} className={cell}>{value}</td>)}
          </tr>
        ))}
      </Table>
      <p className="mt-3 text-[11px] font-mono text-text-secondary">
        {run.ranking.winner ? <>Winner: <span className="text-green-primary">{run.ranking.winner}</span>: {run.ranking.reason}</> : <>No winner: {run.ranking.reason}</>}
      </p>
    </Section>
  );
}

function CandidatesSection({ run }: { run: RunView }) {
  return (
    <Section title="Candidates">
      {run.candidates.length === 0 ? <Empty>No candidates recorded.</Empty> : (
        <Table head={['Candidate', 'Runner', 'Driver', 'Report', 'Branch', 'Head', 'Diff', 'Why']}>
          {run.candidates.map((c) => (
            <tr key={c.candidateId} className="border-b border-border-secondary">
              <td className={cell}>{c.candidateId}</td>
              <td className={cell}>{c.runner}</td>
              <td className={cell}><Status value={c.status} /></td>
              <td className={cell}><Status value={c.report} /></td>
              <td className={cell}>{c.branch}</td>
              <td className={cell}>{short(c.headSha)}</td>
              <td className={cell}>{c.diff ?? '-'}</td>
              <td className={cell}>{c.reason ?? ''}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function MatrixSection({ run }: { run: RunView }) {
  const matrix = run.matrix;
  if (!matrix) return <Section title="Survival matrix"><Empty>No adversarial round in this run.</Empty></Section>;
  return (
    <Section title="Survival matrix">
      <Table head={['Test', 'Author', 'Validity', ...matrix.lanes, 'Clause']}>
        {matrix.tests.map((t) => (
          <tr key={t.id} className="border-b border-border-secondary">
            <td className={cell}>{t.id}</td>
            <td className={cell}>{t.author}</td>
            <td className={cell}>{t.validity}</td>
            {matrix.lanes.map((lane) => <td key={lane} className={cell}><Status value={t.cells[lane]} /></td>)}
            <td className={cell}>{t.specClause}</td>
          </tr>
        ))}
      </Table>
      <p className="mt-3 text-[11px] font-mono text-text-secondary">
        Survival (valid tests by other families): {matrix.survival.map((s) => `${s.candidateId} ${s.text}`).join(', ') || 'none'}
      </p>
    </Section>
  );
}

function DissentSection({ run }: { run: RunView }) {
  return (
    <Section title="Dissent">
      {run.dissent.length === 0 ? <Empty>No dissent.</Empty> : (
        <ul className="space-y-2">
          {run.dissent.map((d) => (
            <li key={d.id} className="text-[11px] font-mono text-text-secondary">
              <div className="flex items-center gap-2">
                <span className="text-text-primary">{d.id}</span>
                <Status value={d.resolution} />
                <span className="text-text-tertiary">{d.source}</span>
              </div>
              <div className="mt-1">{d.summary}</div>
              {d.acceptanceClause && <div className="text-text-tertiary">Acceptance line: {d.acceptanceClause}</div>}
              {d.resolutionReason && <div className="text-text-tertiary">{d.resolutionReason}</div>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SynthesisSection({ run }: { run: RunView }) {
  const s = run.synthesis;
  if (!s) return <Section title="Synthesis"><Empty>No synthesis in this run.</Empty></Section>;
  if (s.skipped) return <Section title="Synthesis"><Empty>Skipped: {s.skipped}.</Empty></Section>;
  return (
    <Section title="Synthesis">
      <div className="text-[11px] font-mono text-text-secondary space-y-1">
        <div>Base: <span className="text-text-primary">{s.base ?? '-'}</span></div>
        <div>Integration branch: {s.branch ?? '-'} at {short(s.headSha)}</div>
        <div className="flex items-center gap-2">Mergeable: <Status value={s.mergeable ? 'yes' : 'no'} />{s.mergeBlock && <span>{s.mergeBlock}</span>}</div>
        {s.grafts.map((g) => (
          <div key={g.id} className="flex items-center gap-2">
            {g.id} from {g.candidateId}: <Status value={g.status} />{g.reason && <span>{g.reason}</span>}
          </div>
        ))}
        {s.dropouts.map((d) => <div key={d.candidateId}>Dropout {d.candidateId}: {d.reason}</div>)}
      </div>
    </Section>
  );
}

function VerdictSection({ run }: { run: RunView }) {
  const v = run.verdict;
  if (!v) return <Section title="Verdict"><Empty>Not verified: run concilium verify-pr to add a verdict.</Empty></Section>;
  return (
    <Section title="Verdict">
      <div className="text-[11px] font-mono text-text-secondary space-y-1">
        <div className="flex items-center gap-2"><Status value={v.verdict} /> at {short(v.headSha)} by {v.verifier}</div>
        <div>{v.reason}</div>
        {v.sameFamilyReason && <div className="text-amber-warning">Warning: same-family verification: {v.sameFamilyReason}</div>}
      </div>
    </Section>
  );
}

function TrailSection({ run }: { run: RunView }) {
  return (
    <Section title="Decision trail">
      {run.trail.length === 0 ? <Empty>No decisions.tsv in this run directory.</Empty> : (
        <Table head={['Step', 'Decision', 'Chosen', 'Alternatives', 'Reason']}>
          {run.trail.map((row) => (
            <tr key={row.event} className="border-b border-border-secondary">
              <td className={cell}>{row.step}</td>
              <td className={cell}>{row.decision}</td>
              <td className={`${cell} text-text-primary`}>{row.chosen}</td>
              <td className={cell}>{row.alternatives.join(', ')}</td>
              <td className={cell}>{row.reason}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function ReportSection({ title, content }: { title: string; content: string | null }) {
  if (!content) return null;
  return (
    <Section title={title}>
      <details>
        <summary className="cursor-pointer text-[11px] font-mono text-text-secondary">Show the report as written</summary>
        <div className="mt-3"><MarkdownRenderer content={content} /></div>
      </details>
    </Section>
  );
}

function Header({ title, onBack, children }: { title: string; onBack: () => void; children?: React.ReactNode }) {
  return (
    <div className="px-6 py-3 flex items-center gap-3 border-b border-border-primary shrink-0">
      <button onClick={onBack} className="text-text-muted hover:text-text-secondary transition-colors" aria-label="Back">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <h2 className="text-sm font-bold font-mono text-text-primary tracking-tight truncate">{title}</h2>
      {children}
    </div>
  );
}

/** Opening a run directory failed: the main process could not read it. */
export function RunOpenError({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="flex flex-col h-screen bg-bg-page overflow-hidden">
      <TitleBar />
      <Header title="Code run" onBack={onBack} />
      <p data-run-error className="p-6 text-xs font-mono text-red-error">{message}</p>
    </div>
  );
}

interface RunViewerScreenProps {
  run: RunView;
  onBack: () => void;
}

/** A code-run directory a CLI run wrote, read-only. */
export default function RunViewerScreen({ run, onBack }: RunViewerScreenProps) {
  return (
    <div data-run-view data-run-id={run.runId ?? ''} className="flex flex-col h-screen bg-bg-page overflow-hidden">
      <TitleBar />
      <Header title={run.runId ? `Code run ${run.runId}` : 'Code run'} onBack={onBack}>
        <Status value={run.status} />
        {run.taskType && <Badge variant="muted">{run.taskType}</Badge>}
      </Header>
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        <div className="text-[11px] font-mono text-text-secondary space-y-1">
          {run.task && <div className="text-text-primary text-xs whitespace-pre-wrap">{run.task}</div>}
          <div>Base {short(run.baseSha)}{run.createdAt ? `, started ${run.createdAt}` : ''}</div>
          <div className="text-text-tertiary truncate">{run.dir}</div>
        </div>
        {run.notes.length > 0 && (
          <ul className="text-[11px] font-mono text-amber-warning space-y-0.5">
            {run.notes.map((n) => <li key={n}>Note: {n}</li>)}
          </ul>
        )}
        <RankingSection run={run} />
        <CandidatesSection run={run} />
        <MatrixSection run={run} />
        <DissentSection run={run} />
        <SynthesisSection run={run} />
        <VerdictSection run={run} />
        <TrailSection run={run} />
        <ReportSection title="synthesis.md" content={run.reports.synthesis} />
        <ReportSection title="reframe.md" content={run.reports.reframe} />
        <ReportSection title="verification.md" content={run.reports.verification} />
      </div>
    </div>
  );
}
