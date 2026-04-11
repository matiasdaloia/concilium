export interface PrFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PrDiff {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  files: PrFile[];
  rawDiff: string;
}

export interface GithubGateway {
  fetchPrDiff(owner: string, repo: string, prNumber: number): Promise<PrDiff>;
  postReviewComment(owner: string, repo: string, prNumber: number, body: string): Promise<void>;
}
