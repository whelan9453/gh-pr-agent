export type ModelPreset = "sonnet" | "haiku";

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
}

// ── Interactive session types ─────────────────────────────────────────────

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WalkthroughCursor {
  mode: "walkthrough";
  fileIndex: number;       // index into walkthroughOrder
  walkthroughOrder: string[]; // ordered file paths
}

export interface FileMaterial {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  numberedPatch: string | null;  // output of buildNumberedPatch
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
  author: string;
  path: string;
  line: number | null;
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
}

export interface AppSession {
  id: string;
  mode: "walkthrough";
  prRef: PullRequestRef;
  model: ModelPreset;
  prTitle: string;
  snapshotSha: string;
  createdAt: string;
  updatedAt: string;
  cursor: WalkthroughCursor;
  messages: ConversationMessage[];
}
