import { buildNumberedPatch } from "../utils/diff-line-mapper.js";
import { GitHubClient, parsePullRequestUrl } from "../clients/github-client.js";
import {
  generateSessionId,
  loadArtifacts,
  loadSession,
  saveArtifacts,
  saveSession
} from "./session-store.js";
import type {
  AppSession,
  ChangedFile,
  DraftComment,
  ExistingInlineComment,
  FileMaterial,
  ModelPreset,
  PrContext,
  PullRequestInfo,
  PullRequestRef,
  ReviewCommentSide,
  SessionArtifacts,
  WalkthroughCursor
} from "../types.js";

// ── Walkthrough ordering ───────────────────────────────────────────────────

type Category = { label: string; re: RegExp };

const CATEGORIES: Category[] = [
  { label: "types/schema/constants", re: /\/(types?|schemas?|constants?|interfaces?|models?)(\/|\.)|types?\.(ts|js)$|schemas?\.(ts|js)$/i },
  { label: "domain/service/utils",   re: /\/(services?|domain|utils?|helpers?|lib)\//i },
  { label: "state/hooks/controllers",re: /\/(hooks?|store|state|contexts?|controllers?|reducers?|actions?)\//i },
  { label: "ui/pages/components",    re: /\/(pages?|components?|views?|screens?|ui)\//i },
  { label: "tests",                  re: /\.(test|spec)\.(ts|tsx|js|jsx)$|\/__(tests?|mocks?)__\//i },
  {
    label: "config/tooling",
    re: /(\/config\/|\/configs?\/|\/scripts?\/|^(vite|tsconfig|jest|eslint|rollup|webpack|babel|\.github)|Dockerfile[^/]*$|docker-compose|\.dockerignore$|azure-pipelines|\.ya?ml$|\.github\/|CHANGELOG|LICENSE)/i
  }
];

function getCategory(filePath: string): number {
  for (const [i, { re }] of CATEGORIES.entries()) {
    if (re.test(filePath)) return i;
  }
  return CATEGORIES.length;
}

export function buildWalkthroughOrder(filePaths: string[]): string[] {
  const originalIndex = new Map(filePaths.map((p, i) => [p, i]));
  return [...filePaths].sort((a, b) => {
    const ca = getCategory(a);
    const cb = getCategory(b);
    if (ca !== cb) return ca - cb;
    return (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0);
  });
}

// ── PR context formatting ──────────────────────────────────────────────────

export function buildPrContextBlock(prContext: PrContext): string {
  const parts: string[] = [];

  if (prContext.description.trim()) {
    parts.push("PR Description:", prContext.description.trim());
  }

  const substantiveReviews = prContext.reviews.filter(
    (r) => r.state !== "COMMENTED" || r.body.trim()
  );
  if (substantiveReviews.length > 0) {
    parts.push("", "Reviews:");
    for (const r of substantiveReviews) {
      const body = r.body.trim() ? ` — "${r.body.trim()}"` : "";
      parts.push(`  @${r.author}: ${r.state}${body}`);
    }
  }

  if (prContext.reviewComments.length > 0) {
    // Group into threads: root comments + their replies
    const roots = prContext.reviewComments.filter((c) => c.replyToId === null);
    const repliesByParent = new Map<number, typeof roots>();
    for (const c of prContext.reviewComments) {
      if (c.replyToId !== null) {
        const list = repliesByParent.get(c.replyToId) ?? [];
        list.push(c);
        repliesByParent.set(c.replyToId, list);
      }
    }
    parts.push("", "Open Review Threads (already tracked — do NOT duplicate in findings):");
    for (const root of roots) {
      const loc = root.line ? `:${root.line}` : "";
      parts.push(`  Thread on ${root.path}${loc}:`);
      parts.push(`    @${root.author}: "${root.body.trim()}"`);
      for (const reply of repliesByParent.get(root.id) ?? []) {
        parts.push(`      @${reply.author} (reply): "${reply.body.trim()}"`);
      }
    }
  }

  if (prContext.issueComments.length > 0) {
    parts.push("", "Discussion:");
    for (const c of prContext.issueComments) {
      parts.push(`  @${c.author}: ${c.body.trim()}`);
    }
  }

  if (parts.length === 0) return "";

  return ["## PR Discussion", "", ...parts].join("\n");
}

// ── Interfaces ─────────────────────────────────────────────────────────────

export interface DraftCommentInput {
  id?: string;
  path: string;
  body: string;
  side: ReviewCommentSide;
  startRowKey: string;
  endRowKey: string;
}

export interface SessionOverview {
  session: AppSession;
  prInfo: PullRequestInfo;
  prContext: PrContext;
  reviewSummary: string;
  drafts: DraftComment[];
  chatMessages: Array<{ role: "user" | "assistant"; content: string; annotations?: Array<{ context: string; severity: "must-fix" | "should-fix"; description: string; body: string; path: string | null; line: number | null; alreadyTracked?: boolean }> }>;
  files: Array<{
    path: string;
    previousPath: string | null;
    status: string;
    additions: number;
    deletions: number;
    draftCount: number;
    existingCommentCount: number;
  }>;
}

export async function fetchPrArtifacts(
  prUrl: string,
  githubToken: string
): Promise<{ prRef: PullRequestRef; artifacts: SessionArtifacts }> {
  const prRef = parsePullRequestUrl(prUrl);
  const github = new GitHubClient(githubToken, prRef.apiBaseUrl);

  const [prInfo, changedFiles, issueComments, reviews, reviewComments] = await Promise.all([
    github.getPullRequest(prRef),
    github.listPullRequestFiles(prRef),
    github.listIssueComments(prRef),
    github.listReviews(prRef),
    github.listReviewComments(prRef)
  ]);

  const commentsByPath = groupCommentsByPath(reviewComments);

  const files = await mapWithConcurrency(
    changedFiles,
    (file) => materializeFile(prRef, prInfo, file, commentsByPath.get(file.path) ?? [], github),
    5
  );

  return {
    prRef,
    artifacts: {
      prInfo,
      prContext: {
        description: prInfo.body,
        issueComments,
        reviews,
        reviewComments
      },
      files,
      walkthroughOrder: buildWalkthroughOrder(files.map((file) => file.path)),
      drafts: [],
      reviewSummary: "",
      chatHistory: []
    }
  };
}

export async function createSavedSession(
  prUrl: string,
  githubToken: string,
  model: ModelPreset,
  mode: AppSession["mode"]
): Promise<AppSession> {
  const { prRef, artifacts } = await fetchPrArtifacts(prUrl, githubToken);
  const id = generateSessionId();
  const now = new Date().toISOString();

  const cursor: WalkthroughCursor = {
    mode: "walkthrough",
    fileIndex: 0,
    walkthroughOrder: artifacts.walkthroughOrder
  };

  const session: AppSession = {
    id,
    mode,
    prRef,
    model,
    prTitle: artifacts.prInfo.title,
    snapshotSha: artifacts.prInfo.headSha,
    createdAt: now,
    updatedAt: now,
    cursor,
    messages: []
  };

  saveArtifacts(id, artifacts);
  saveSession(session);
  return session;
}

export function getSessionOverview(sessionId: string): SessionOverview {
  const session = loadSession(sessionId);
  const artifacts = loadArtifacts(sessionId);
  const chatHistory = artifacts.chatHistory ?? [];
  // Skip index 0 (the large PR diff context message sent to Claude) — only expose display messages
  const chatMessages = chatHistory.slice(1).map((m) => {
    const content = stripJsonFence(m.content);
    if (m.role === "assistant") {
      const annotations = extractAnnotations(m.content);
      return annotations.length > 0 ? { role: m.role, content, annotations } : { role: m.role, content };
    }
    return { role: m.role, content };
  });
  return {
    session,
    prInfo: artifacts.prInfo,
    prContext: artifacts.prContext,
    reviewSummary: artifacts.reviewSummary,
    drafts: artifacts.drafts,
    chatMessages,
    files: artifacts.walkthroughOrder.map((path) => {
      const file = artifacts.files.find((entry) => entry.path === path);
      if (!file) {
        throw new Error(`Missing file material for ${path}`);
      }
      return {
        path: file.path,
        previousPath: file.previousPath,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        draftCount: artifacts.drafts.filter((draft) => draft.path === file.path).length,
        existingCommentCount: file.existingComments.length
      };
    })
  };
}

export function getFileMaterial(sessionId: string, filePath: string): FileMaterial {
  const artifacts = loadArtifacts(sessionId);
  const file = artifacts.files.find((entry) => entry.path === filePath);
  if (!file) {
    throw new Error(`File not found in session: ${filePath}`);
  }
  return file;
}

export function upsertDraftComment(sessionId: string, input: DraftCommentInput): DraftComment {
  const artifacts = loadArtifacts(sessionId);
  const file = artifacts.files.find((entry) => entry.path === input.path);
  if (!file) {
    throw new Error(`Cannot create draft for unknown file: ${input.path}`);
  }

  const normalized = normalizeDraftComment(file, input, artifacts.drafts.find((draft) => draft.id === input.id));
  const nextDrafts = artifacts.drafts.filter((draft) => draft.id !== normalized.id);
  nextDrafts.push(normalized);
  artifacts.drafts = sortDrafts(nextDrafts);
  saveArtifacts(sessionId, artifacts);
  return normalized;
}

export function deleteDraftComment(sessionId: string, draftId: string): void {
  const artifacts = loadArtifacts(sessionId);
  artifacts.drafts = artifacts.drafts.filter((draft) => draft.id !== draftId);
  saveArtifacts(sessionId, artifacts);
}

export function setReviewSummary(sessionId: string, reviewSummary: string): void {
  const artifacts = loadArtifacts(sessionId);
  artifacts.reviewSummary = reviewSummary;
  saveArtifacts(sessionId, artifacts);
}

export function groupCommentsByPath(comments: PrContext["reviewComments"]): Map<string, ExistingInlineComment[]> {
  const grouped = new Map<string, ExistingInlineComment[]>();
  for (const comment of comments) {
    const next = grouped.get(comment.path) ?? [];
    next.push({
      id: comment.id,
      author: comment.author,
      path: comment.path,
      body: comment.body,
      createdAt: comment.createdAt,
      line: comment.line,
      side: comment.side,
      startLine: comment.startLine,
      startSide: comment.startSide,
      replyToId: comment.replyToId
    });
    grouped.set(comment.path, next);
  }
  return grouped;
}

async function materializeFile(
  prRef: PullRequestRef,
  prInfo: PullRequestInfo,
  file: ChangedFile,
  existingComments: ExistingInlineComment[],
  github: GitHubClient
): Promise<FileMaterial> {
  const [baseContent, headContent] = await Promise.all([
    shouldFetchBaseContent(file.status)
      ? github.getRepoFileContent(prRef, file.previousPath ?? file.path, prInfo.baseSha)
      : Promise.resolve(null),
    shouldFetchHeadContent(file.status)
      ? github.getRepoFileContent(prRef, file.path, prInfo.headSha)
      : Promise.resolve(null)
  ]);

  const patchDetails = file.patch
    ? buildNumberedPatch(file.patch)
    : { numberedPatch: null, diffRows: [] };

  return {
    path: file.path,
    previousPath: file.previousPath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    baseRef: prInfo.baseSha,
    headRef: prInfo.headSha,
    patch: file.patch,
    numberedPatch: patchDetails.numberedPatch,
    baseContent,
    headContent,
    diffRows: patchDetails.diffRows,
    existingComments
  };
}

function shouldFetchBaseContent(status: string): boolean {
  return status !== "added";
}

function shouldFetchHeadContent(status: string): boolean {
  return status !== "removed";
}

function normalizeDraftComment(
  file: FileMaterial,
  input: DraftCommentInput,
  existingDraft?: DraftComment
): DraftComment {
  const body = input.body.trim();
  if (!body) {
    throw new Error("Draft comment body cannot be empty.");
  }

  const startIndex = file.diffRows.findIndex((row) => row.key === input.startRowKey);
  const endIndex = file.diffRows.findIndex((row) => row.key === input.endRowKey);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error("Draft comment selection does not match the current diff.");
  }

  const lowerIndex = Math.min(startIndex, endIndex);
  const upperIndex = Math.max(startIndex, endIndex);
  const startRow = file.diffRows[lowerIndex];
  const endRow = file.diffRows[upperIndex];
  if (!startRow || !endRow) {
    throw new Error("Draft comment selection is incomplete.");
  }
  if (startRow.hunkIndex !== endRow.hunkIndex) {
    throw new Error("Draft comment range cannot cross diff hunks.");
  }

  const selectedRows = file.diffRows.slice(lowerIndex, upperIndex + 1);
  if (selectedRows.some((row) => row.hunkIndex !== startRow.hunkIndex)) {
    throw new Error("Draft comment range cannot cross diff hunks.");
  }

  const selectable = input.side === "LEFT" ? "leftSelectable" : "rightSelectable";
  if (selectedRows.some((row) => !row[selectable])) {
    throw new Error("Draft comment range must stay on selectable rows for one diff side.");
  }

  const startLine =
    input.side === "LEFT" ? startRow.oldLine : startRow.newLine;
  const endLine =
    input.side === "LEFT" ? endRow.oldLine : endRow.newLine;
  if (startLine === null || endLine === null) {
    throw new Error("Draft comment range could not be mapped to GitHub diff lines.");
  }

  const now = new Date().toISOString();
  return {
    id: existingDraft?.id ?? generateSessionId(),
    path: file.path,
    body,
    side: input.side,
    line: endLine,
    startLine: startLine === endLine ? null : startLine,
    startSide: startLine === endLine ? null : input.side,
    startRowKey: startRow.key,
    endRowKey: endRow.key,
    hunkIndex: startRow.hunkIndex,
    createdAt: existingDraft?.createdAt ?? now,
    updatedAt: now
  };
}

function extractAnnotations(raw: string): Array<{ context: string; severity: "must-fix" | "should-fix"; description: string; body: string; path: string | null; line: number | null; alreadyTracked?: boolean }> {
  const match = /```json\s*([\s\S]*?)```\s*$/.exec(raw);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1] ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((c) => {
      if (typeof c !== "object" || c === null) return [];
      const r = c as Record<string, unknown>;
      if (typeof r["context"] !== "string" || typeof r["body"] !== "string") return [];
      return [{
        context: r["context"],
        severity: r["severity"] === "should-fix" ? "should-fix" as const : "must-fix" as const,
        description: typeof r["description"] === "string" ? r["description"] : "",
        body: r["body"],
        path: typeof r["path"] === "string" ? r["path"] : null,
        line: typeof r["line"] === "number" ? r["line"] : null,
        ...(r["alreadyTracked"] === true ? { alreadyTracked: true } : {})
      }];
    });
  } catch {
    return [];
  }
}

function stripJsonFence(text: string): string {
  return text.replace(/```json\s*[\s\S]*?```\s*$/m, "").trimEnd();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function sortDrafts(drafts: DraftComment[]): DraftComment[] {
  return [...drafts].sort((left, right) => {
    if (left.path !== right.path) {
      return left.path.localeCompare(right.path);
    }
    if (left.hunkIndex !== right.hunkIndex) {
      return left.hunkIndex - right.hunkIndex;
    }
    const leftStart = left.startLine ?? left.line;
    const rightStart = right.startLine ?? right.line;
    return leftStart - rightStart;
  });
}
