import type { GithubGateway, PrDiff, PrFile } from '../ports/github-gateway.js';
import { ConciliumError, ConfigError } from '../shared/errors.js';

const GITHUB_API = 'https://api.github.com';
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

export function parsePrUrl(url: string): { owner: string; repo: string; prNumber: number } {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );
  if (!match) {
    throw new ConfigError(`Invalid GitHub PR URL: ${url}. Expected format: https://github.com/owner/repo/pull/123`);
  }
  return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) };
}

export class GitHubRestGateway implements GithubGateway {
  private readonly token: string | undefined;

  constructor(opts: { token?: string } = {}) {
    this.token = opts.token || process.env.GITHUB_TOKEN;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { ...GITHUB_HEADERS };
    if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`;
    }
    return h;
  }

  async fetchPrDiff(owner: string, repo: string, prNumber: number): Promise<PrDiff> {
    const [prData, filesData, rawDiff] = await Promise.all([
      this.fetchJson<{ title: string; body: string | null }>(
        `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
      ),
      this.fetchJson<Array<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      }>>(
        `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/files`,
      ),
      this.fetchRawDiff(owner, repo, prNumber),
    ]);

    const files: PrFile[] = filesData.map((f) => ({
      filename: f.filename,
      status: f.status as PrFile['status'],
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }));

    return {
      owner,
      repo,
      prNumber,
      title: prData.title,
      body: prData.body ?? '',
      files,
      rawDiff,
    };
  }

  async postReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<void> {
    if (!this.token) {
      throw new ConfigError('GITHUB_TOKEN required to post comments');
    }

    const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'COMMENT', body }),
    });

    if (!response.ok) {
      await this.handleApiError(response, 'postReviewComment');
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) {
      await this.handleApiError(response, url);
    }
    return response.json() as Promise<T>;
  }

  private async fetchRawDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`;
    const response = await fetch(url, {
      headers: { ...this.headers(), Accept: 'application/vnd.github.diff' },
    });
    if (!response.ok) {
      await this.handleApiError(response, 'fetchRawDiff');
    }
    return response.text();
  }

  private async handleApiError(response: Response, context: string): Promise<never> {
    const resetHeader = response.headers.get('X-RateLimit-Reset');
    if ((response.status === 403 || response.status === 429) && resetHeader) {
      throw new ConciliumError(
        `GitHub API rate limit hit (${context}). Resets at ${resetHeader}`,
        'GITHUB_RATE_LIMIT',
      );
    }
    const body = await response.text().catch(() => '');
    throw new ConciliumError(
      `GitHub API error ${response.status} (${context}): ${body.slice(0, 200)}`,
      'GITHUB_API_ERROR',
    );
  }
}
