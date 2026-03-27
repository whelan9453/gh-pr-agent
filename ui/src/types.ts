export type ReviewCommentSide = "LEFT" | "RIGHT";
export type DiffRowType = "hunk" | "context" | "add" | "del";

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface PullRequestInfo {
  title: string;
  body: string;
  state: string;
  author: string;
  base: string;
  baseSha: string;
  head: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PrReview {
  author: string;
  state: string;
  body: string;
  submittedAt: string;
}

export interface DiffRow {
  key: string;
  hunkIndex: number;
  type: DiffRowType;
  header: string | null;
  oldLine: number | null;
  newLine: number | null;
  leftText: string;
  rightText: string;
  leftSelectable: boolean;
  rightSelectable: boolean;
}

export interface ExistingInlineComment {
  id: number;
  author: string;
  path: string;
  body: string;
  createdAt: string;
  line: number | null;
  side: ReviewCommentSide | null;
  startLine: number | null;
  startSide: ReviewCommentSide | null;
  replyToId: number | null;
}

export interface DraftComment {
  id: string;
  path: string;
  body: string;
  side: ReviewCommentSide;
  line: number;
  startLine: number | null;
  startSide: ReviewCommentSide | null;
  startRowKey: string;
  endRowKey: string;
  hunkIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileSummary {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  draftCount: number;
  existingCommentCount: number;
}

export interface FileMaterial {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  baseRef: string;
  headRef: string;
  patch: string | null;
  numberedPatch: string | null;
  baseContent: string | null;
  headContent: string | null;
  diffRows: DiffRow[];
  existingComments: ExistingInlineComment[];
}

export interface SessionOverviewResponse {
  session: {
    id: string;
    mode: "walkthrough" | "ui-review";
    prRef: PullRequestRef;
    prTitle: string;
    snapshotSha: string;
    createdAt: string;
    updatedAt: string;
  };
  prInfo: PullRequestInfo;
  prContext: {
    description: string;
    reviews: PrReview[];
    reviewComments: ExistingInlineComment[];
    issueComments: Array<{ author: string; body: string; createdAt: string }>;
  };
  reviewSummary: string;
  drafts: DraftComment[];
  files: FileSummary[];
}

export interface FileResponse {
  file: FileMaterial;
  drafts: DraftComment[];
}

export interface DraftPayload {
  id?: string;
  path: string;
  body: string;
  side: ReviewCommentSide;
  startRowKey: string;
  endRowKey: string;
}
