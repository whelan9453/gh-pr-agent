export type ModelPreset = "sonnet" | "haiku";

export interface PersistedConfig {
  azureFoundryBaseUrl?: string;
  defaultModel?: ModelPreset;
  deployments?: Partial<Record<ModelPreset, string>>;
  promptFile?: string;
}

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

export interface FileIssue {
  title: string;
  severity: "high" | "medium" | "low";
  line: number | null;
  confidence: "high" | "medium" | "low";
  details: string;
}

export interface FileReview {
  path: string;
  previousPath: string | null;
  status: string;
  skipped: boolean;
  skipReason: string | null;
  reviewFailed: boolean;
  reviewFailureReason: string | null;
  truncated: boolean;
  summary: string[];
  issues: FileIssue[];
}

export interface ReviewReport {
  pullRequest: {
    owner: string;
    repo: string;
    number: number;
    url: string;
    title: string;
    base: string;
    head: string;
  };
  overallSummary: string;
  files: FileReview[];
}

export interface ReviewPayload {
  prompt: string;
  input: string;
}

export interface FileReviewDraft {
  summary: string[];
  issues: FileIssue[];
}

export interface AppConfig {
  githubToken: string;
  azureFoundryBaseUrl: string;
  azureFoundryApiKey: string;
  selectedModel: ModelPreset;
  deploymentName: string;
  promptFile?: string;
  jsonOutput?: string;
}

export interface StoredAuthStatus {
  keychainAvailable: boolean;
  githubTokenStored: boolean;
  azureFoundryApiKeyStored: boolean;
  config: PersistedConfig;
}
