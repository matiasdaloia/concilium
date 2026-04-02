import { describe, it, expect } from 'vitest';
import { buildVerifyPrompt } from './prompts.js';
import type { PrDiff } from '../../ports/github-gateway.js';

const baseDiff: PrDiff = {
  owner: 'org',
  repo: 'repo',
  prNumber: 42,
  title: 'Fix auth bug',
  body: 'This PR fixes the authentication bypass in the login flow.',
  files: [
    { filename: 'src/auth.ts', status: 'modified', additions: 10, deletions: 3, patch: '@@ -1,5 +1,12 @@\n+import { validate } from "zod";\n' },
    { filename: 'src/utils.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -10,3 +10,4 @@\n+export const helper = true;\n' },
  ],
  rawDiff: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'),
};

describe('buildVerifyPrompt', () => {
  it('includes PR title and file list', () => {
    const prompt = buildVerifyPrompt(baseDiff);
    expect(prompt).toContain('Fix auth bug');
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('src/utils.ts');
  });

  it('truncates diff when exceeding maxDiffLines', () => {
    const prompt = buildVerifyPrompt(baseDiff, { maxDiffLines: 10 });
    expect(prompt).toContain('Diff truncated to 10 lines');
  });

  it('does not show truncation notice when within limit', () => {
    const prompt = buildVerifyPrompt(baseDiff, { maxDiffLines: 500 });
    expect(prompt).not.toContain('truncated');
  });

  it('filters to focusFiles and notes omitted files', () => {
    const prompt = buildVerifyPrompt(baseDiff, { focusFiles: ['src/auth.ts'] });
    expect(prompt).toContain('validate');
    expect(prompt).toContain('Omitted files');
    expect(prompt).toContain('src/utils.ts');
  });

  it('appends custom instructions', () => {
    const prompt = buildVerifyPrompt(baseDiff, { customInstructions: 'Focus on SQL injection vectors' });
    expect(prompt).toContain('Focus on SQL injection vectors');
  });

  it('contains review instructions, not rewrite instructions', () => {
    const prompt = buildVerifyPrompt(baseDiff);
    expect(prompt).toContain('Do NOT rewrite');
    expect(prompt).toContain('code review');
  });
});
