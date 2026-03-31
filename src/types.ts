import type { ClientBackend } from "./clients/conversation-client.js";

export type ModelPreset = "sonnet" | "haiku";
export type ReviewCommentSide = "LEFT" | "RIGHT";
export type DiffRowType = "hunk" | "context" | "add" | "del";

export interface PullRequestRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  apiBaseUrl: string;
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

export interface ChangedFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
  contentsUrl: string | null;
  blobUrl: string | null;
}

export interface AppConfig {
  githubToken: string;
  azureFoundryBaseUrl: string;
  azureFoundryApiKey: string;
  selectedModel: ModelPreset;
  deploymentName: string;
  backend?: ClientBackend;
  claudeCliModel?: string;
  codexCliModel?: string;
}

// ── Interactive session types ─────────────────────────────────────────────

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WalkthroughCursor {
  mode: "walkthrough";
  fileIndex: number;
  walkthroughOrder: string[]; // ordered file paths
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

export interface ReviewSubmissionPayload {
  body: string;
  event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
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

export interface PrIssueComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface PrReview {
  author: string;
  state: string;
  body: string;
  submittedAt: string;
}

export interface PrReviewComment {
  id: number;
  author: string;
  path: string;
  line: number | null;
  side: ReviewCommentSide | null;
  startLine: number | null;
  startSide: ReviewCommentSide | null;
  replyToId: number | null;
  body: string;
  createdAt: string;
}

export interface PrContext {
  description: string;
  issueComments: PrIssueComment[];
  reviews: PrReview[];
  reviewComments: PrReviewComment[];
}

export interface SessionArtifacts {
  prInfo: PullRequestInfo;
  prContext: PrContext;
  files: FileMaterial[];
  walkthroughOrder: string[];
  drafts: DraftComment[];
  reviewSummary: string;
  chatHistory: ConversationMessage[];
}

export interface AppSession {
  id: string;
  mode: "walkthrough" | "ui-review";
  prRef: PullRequestRef;
  model: ModelPreset;
  prTitle: string;
  snapshotSha: string;
  createdAt: string;
  updatedAt: string;
  cursor: WalkthroughCursor;
  messages: ConversationMessage[];
}
