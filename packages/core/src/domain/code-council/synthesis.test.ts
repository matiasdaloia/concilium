/**
 * @license MIT
 * Copyright (c) 2025 Matias Daloia
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { graftPrompt, integratorBrief, parseGraftAnswer, synthesisMarkdown, type Graft, type Synthesis } from './synthesis.js';

describe('graftPrompt', () => {
  it('should hold the task, the base and each other candidate by letter with its evidence and diff, and ask for JSON only', () => {
    const prompt = graftPrompt('make sum strict', { label: 'Base', diff: '+base line', evidence: ['ok, gate: test: pass'] }, [
      { label: 'A', diff: '+a line', evidence: [] },
      { label: 'B', diff: '+b line', evidence: ['issue, gate: lint: fail'] },
    ]);
    expect(prompt.startsWith('You are choosing grafts')).toBe(true);
    expect(prompt).toContain('Task:\nmake sum strict');
    expect(prompt).toContain('## Base\nEvidence:\n- ok, gate: test: pass');
    expect(prompt).toContain('## Candidate A\nEvidence:\n- none');
    expect(prompt).toContain('+b line');
    expect(prompt).toContain('at most 2 ideas');
    expect(prompt).toMatch(/Reply with only a JSON object:\n\{"grafts": \[/);
  });
});

describe('parseGraftAnswer', () => {
  const files = { A: ['sum.js', 'sum.test.js'], B: ['half.js'] };

  it('should read fenced JSON and keep valid grafts with their source', () => {
    const answer = '```json\n{"grafts": [{"candidate": "Candidate A", "files": ["sum.test.js"], "hunk": "@@ -0,0 +1 @@", "instruction": "Add the empty-input test.", "why": "The base misses it."}]}\n```';
    expect(parseGraftAnswer(answer, files)).toEqual({
      grafts: [{ label: 'A', files: ['sum.test.js'], hunk: '@@ -0,0 +1 @@', instruction: 'Add the empty-input test.', why: 'The base misses it.' }],
      notes: [],
    });
  });

  it('should accept no graft at all', () => {
    expect(parseGraftAnswer('{"grafts": []}', files)).toEqual({ grafts: [], notes: [] });
  });

  it('should drop, by name, an unknown candidate, a file outside its diff, a missing instruction or reason, and a third graft', () => {
    const g = (candidate: string, file: string, extra: object = {}) => ({ candidate, files: [file], instruction: 'do it', why: 'better', ...extra });
    const answer = JSON.stringify({ grafts: [
      g('C', 'x.js'), g('B', 'sum.js'), g('A', 'sum.js', { instruction: ' ' }), g('A', 'sum.js', { why: '' }), { candidate: 'A', files: [], instruction: 'i', why: 'w' },
      g('A', 'sum.js'), g('A', 'sum.test.js'), g('A', 'sum.js'),
    ] });
    const { grafts, notes } = parseGraftAnswer(answer, files);
    expect(grafts.map((x) => [x.label, x.files[0], x.hunk])).toEqual([['A', 'sum.js', null], ['A', 'sum.test.js', null]]);
    expect(notes).toEqual([
      'grafts[0] dropped: candidate must be one of A, B',
      "grafts[1] dropped: sum.js is not in candidate B's diff",
      'grafts[2] dropped: has no instruction',
      'grafts[3] dropped: has no reason',
      'grafts[4] dropped: names no file',
      'grafts[7] dropped: candidate A already has 2 grafts',
    ]);
  });

  it('should reject an answer without JSON or without a grafts list', () => {
    expect(() => parseGraftAnswer('no idea', files)).toThrow('the graft answer holds no JSON');
    expect(() => parseGraftAnswer('{"ideas": []}', files)).toThrow('the graft answer has no "grafts" list');
  });
});

describe('integratorBrief', () => {
  it('should be a write-mode brief in the integration worktree with the graft and the source diff, read-only', () => {
    const brief = integratorBrief({
      task: 'make sum strict', worktree: '/wt/integration', branch: 'concilium/r/integration', sourcePatch: '/tmp/x/source.patch',
      graft: { id: 'graft-1', candidateId: 'codex', files: ['sum.test.js'], hunk: null, instruction: 'Add the test.', why: 'Coverage.' },
    });
    expect(brief).toMatchObject({ mode: 'code', cwd: '/wt/integration', allowedActions: ['read', 'write', 'shell'] });
    expect(brief.task).toContain('Graft graft-1:\nInstruction: Add the test.\nWhy: Coverage.\nSource files: sum.test.js');
    expect(brief.task).toContain('by hand');
    expect(brief.task).not.toContain('codex');
    expect(brief.constraints).toContain('Source solution diff, read-only: /tmp/x/source.patch');
  });
});

describe('synthesisMarkdown', () => {
  const integrator = { provider: 'claude', model: null, status: 'ok' as const, durationMs: 1, errors: [], finalText: '', brief: null };
  const applied: Graft = {
    id: 'graft-1', candidateId: 'codex', files: ['sum.test.js'], hunk: null, instruction: 'Add the test.', why: 'Coverage.',
    status: 'applied', commitSha: 'c1', revertSha: null, reason: '', evidence: [], integrator,
  };
  const rejected: Graft = {
    id: 'graft-2', candidateId: 'gemini', files: ['sum.js'], hunk: '@@ -1 +1 @@', instruction: 'Return 0.', why: 'Simpler.',
    status: 'rejected', commitSha: 'c2', revertSha: 'r2', reason: 'gate test passed before the graft and fails after it', integrator,
    evidence: [{ kind: 'gate', detail: 'test: fail', sha: 'c2', output: 'Error: 1 + 2\n' }],
  };
  const synthesis: Synthesis = {
    base: { candidateId: 'claude', headSha: 'h0', reason: 'best on the evidence' }, branch: 'concilium/r/integration', worktree: '/wt/integration', headSha: 'r2',
    picker: { provider: 'gemini', sameFamily: false, sameFamilyReason: null }, notes: ['grafts[3] dropped: has no reason'],
    grafts: [applied, rejected], dropouts: [{ candidateId: 'opencode', reason: 'BLOCKED: made no change' }],
    checks: { sha: 'c1', gates: { test: 'pass' }, tests: { 'openai-1': 'pass' } },
    patchPath: '/data/runs/r/result.patch', synthesisPath: '/data/runs/r/synthesis.md', mergeable: true, mergeCheck: { applies: true, targetSha: 'tip', output: '' },
  };

  it('should list the base, applied grafts with their source, rejected grafts with evidence, dropouts, the checks and the patch', () => {
    const md = synthesisMarkdown(synthesis, { id: 'r', task: 'make sum strict', baseSha: 'b'.repeat(40) });
    expect(md).toContain('## Base\n\n`claude` at `h0` (best on the evidence).');
    expect(md).toContain('## Applied grafts\n\n- **graft-1** from `codex` (`sum.test.js`): Add the test. Why: Coverage. Commit `c1`.');
    expect(md).toContain('## Rejected grafts\n\n- **graft-2** from `gemini` (`sum.js`, hunk `@@ -1 +1 @@`): Return 0. Why: Simpler.\n  Rejected: gate test passed before the graft and fails after it. Commit `c2`, reverted by `r2`.\n  - gate: test: fail at `c2`\n    ```\n    Error: 1 + 2\n    ```');
    expect(md).toContain('## Dropouts\n\n- `opencode`: BLOCKED: made no change');
    expect(md).toContain('- gate test: pass\n- adversarial test openai-1: pass');
    expect(md).toContain('- Patch: `/data/runs/r/result.patch` (`bbbbbbbbbbbb..r2`)');
    expect(md).toContain('- Mergeable: yes, `git apply --check` against `HEAD` at `tip`');
  });

  it('should say why it was skipped, and why a patch is not mergeable', () => {
    expect(synthesisMarkdown({ ...synthesis, skipped: 'no winner' }, { id: 'r', task: 't', baseSha: 'b' })).toContain('Skipped: no winner.');
    const md = synthesisMarkdown({ ...synthesis, mergeable: false, mergeCheck: { applies: false, targetSha: 'tip', output: 'error: patch failed: sum.js:1\nmore' } }, { id: 'r', task: 't', baseSha: 'b' });
    expect(md).toContain('- Mergeable: no, `git apply --check` against `HEAD` at `tip`: error: patch failed: sum.js:1');
  });
});
