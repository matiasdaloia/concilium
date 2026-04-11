import { describe, it, expect } from 'vitest';
import { parsePrUrl } from './github-rest-gateway.js';

describe('parsePrUrl', () => {
  it('extracts owner, repo, prNumber from standard URL', () => {
    const result = parsePrUrl('https://github.com/org/repo/pull/123');
    expect(result).toEqual({ owner: 'org', repo: 'repo', prNumber: 123 });
  });

  it('handles URLs with trailing slashes or fragments', () => {
    const result = parsePrUrl('https://github.com/my-org/my-repo/pull/42/files');
    expect(result).toEqual({ owner: 'my-org', repo: 'my-repo', prNumber: 42 });
  });

  it('throws ConfigError for invalid URLs', () => {
    expect(() => parsePrUrl('https://gitlab.com/org/repo/merge_requests/1')).toThrow('Invalid GitHub PR URL');
    expect(() => parsePrUrl('not-a-url')).toThrow('Invalid GitHub PR URL');
    expect(() => parsePrUrl('https://github.com/org/repo/issues/5')).toThrow('Invalid GitHub PR URL');
  });
});
