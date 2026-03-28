import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWalkthroughOrder } from "./walkthrough-order.js";
import { buildNumberedPatch } from "./diff-line-mapper.js";
import { GitHubClient, parsePullRequestUrl } from "./github-client.js";
import { loadPrompt } from "./prompt-loader.js";
import { buildPrContextBlock } from "./interactive-session.js";
import type { ConversationClient } from "./conversation-client.js";
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
  ConversationMessage,
  DraftComment,
  ExistingInlineComment,
  FileMaterial,
  ModelPreset,
  PrContext,
  PullRequestInfo,
  PullRequestRef,
  ReviewCommentSide,
  ReviewSubmissionPayload,
  SessionArtifacts,
  WalkthroughCursor
} from "./types.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const TOTAL_PATCH_BUDGET = 100_000;

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
  chatMessages: Array<{ role: "user" | "assistant"; content: string }>;
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

  const files = await Promise.all(
    changedFiles.map((file) =>
      materializeFile(prRef, prInfo, file, commentsByPath.get(file.path) ?? [], github)
    )
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
  const chatMessages = chatHistory.slice(1).map((m) => ({
    role: m.role,
    content: stripJsonFence(m.content)
  }));
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

export async function submitReview(
  sessionId: string,
  githubToken: string,
  payload: ReviewSubmissionPayload
): Promise<{ url: string; artifacts: SessionArtifacts }> {
  const session = loadSession(sessionId);
  const artifacts = loadArtifacts(sessionId);
  const github = new GitHubClient(githubToken, session.prRef.apiBaseUrl);
  const reviewBody = payload.body.trim();
  const event = payload.event ?? "COMMENT";

  if (event !== "APPROVE" && artifacts.drafts.length === 0 && !reviewBody) {
    throw new Error("Review submission must include a summary or at least one inline comment.");
  }

  const url = await github.createReview(
    session.prRef,
    artifacts.prInfo.headSha,
    reviewBody,
    artifacts.drafts.map((draft) => ({
      path: draft.path,
      body: draft.body,
      line: draft.line,
      side: draft.side,
      startLine: draft.startLine,
      startSide: draft.startSide
    })),
    event
  );

  const [issueComments, reviews, reviewComments] = await Promise.all([
    github.listIssueComments(session.prRef),
    github.listReviews(session.prRef),
    github.listReviewComments(session.prRef)
  ]);

  const commentsByPath = groupCommentsByPath(reviewComments);
  artifacts.prContext = {
    description: artifacts.prInfo.body,
    issueComments,
    reviews,
    reviewComments
  };
  artifacts.files = artifacts.files.map((file) => ({
    ...file,
    existingComments: commentsByPath.get(file.path) ?? []
  }));
  artifacts.drafts = [];
  artifacts.reviewSummary = "";
  saveArtifacts(sessionId, artifacts);

  session.updatedAt = new Date().toISOString();
  saveSession(session);

  return { url, artifacts };
}

export async function sendAnnotationChatMessage(
  sessionId: string,
  annotationContext: string,
  annotationBody: string,
  annotationPath: string | null,
  thread: Array<{ role: "user" | "assistant"; content: string }>,
  userMessage: string,
  client: ConversationClient
): Promise<{ reply: string }> {
  const artifacts = loadArtifacts(sessionId);
  let fileContext = "";
  if (annotationPath) {
    const file = artifacts.files.find((f) => f.path === annotationPath);
    if (file?.numberedPatch) {
      fileContext = `\n\n## File: ${annotationPath}\n\`\`\`diff\n${file.numberedPatch}\n\`\`\``;
    }
  }
  const systemPrompt = [
    "You are a senior code reviewer answering questions about a specific issue found in a pull request.",
    "",
    `Issue: ${annotationContext}`,
    `Details: ${annotationBody}`,
    fileContext,
    "",
    "Answer concisely and technically. If asked to write a GitHub review comment, write it in English, professional and specific."
  ].join("\n");
  const messages: ConversationMessage[] = [
    ...thread,
    { role: "user", content: userMessage }
  ];
  const reply = await client.send(systemPrompt, messages, 1500);
  return { reply };
}

export async function runAiReview(
  sessionId: string,
  client: ConversationClient,
  onProgress?: (message: string) => void
): Promise<{ analysis: string; draftCount: number; comments: Array<{ context: string; severity: "must-fix" | "should-fix"; description: string; body: string; path: string | null; line: number | null }> }> {
  onProgress?.("載入 PR 資料...");
  const session = loadSession(sessionId);
  const artifacts = loadArtifacts(sessionId);

  onProgress?.("載入分析提示詞...");
  const systemPrompt = await loadPrompt(join(MODULE_DIR, "..", "prompts", "pr-summary.md"));

  const fileCount = artifacts.files.length;
  const totalChanges = artifacts.files.reduce((s, f) => s + f.additions + f.deletions, 0);
  onProgress?.(`組合差異內容（${fileCount} 個檔案，${totalChanges} 行變更）...`);
  const userMessage = buildAiReviewMessage(session, artifacts);
  const messages: ConversationMessage[] = [{ role: "user", content: userMessage }];

  onProgress?.("傳送至 Claude，等待回應...");
  const raw = await client.send(systemPrompt, messages, 8192);

  onProgress?.("解析分析結果...");
  const { analysis, comments } = parseAiComments(raw);

  // Reload artifacts after the (potentially long) LLM call to pick up any concurrent changes
  // (e.g., drafts added by the user while the model was running) before overwriting chatHistory.
  const updated = loadArtifacts(sessionId);
  updated.chatHistory = [
    { role: "user", content: userMessage },
    { role: "assistant", content: raw }
  ];
  saveArtifacts(sessionId, updated);

  return { analysis, draftCount: 0, comments };
}

export async function sendChatMessage(
  sessionId: string,
  message: string,
  client: ConversationClient
): Promise<{ reply: string }> {
  const artifacts = loadArtifacts(sessionId);
  const systemPrompt = await loadPrompt(join(MODULE_DIR, "..", "prompts", "pr-summary.md"));

  const history: ConversationMessage[] = artifacts.chatHistory ?? [];
  const messages: ConversationMessage[] = [...history, { role: "user", content: message }];
  const reply = await client.send(systemPrompt, messages, 3000);

  artifacts.chatHistory = [...messages, { role: "assistant", content: reply }];
  saveArtifacts(sessionId, artifacts);

  return { reply };
}

function buildAiReviewMessage(session: AppSession, artifacts: SessionArtifacts): string {
  const { prInfo, prContext, files } = artifacts;
  const totalPatchChars = files.reduce((sum, f) => sum + (f.numberedPatch?.length ?? 0), 0);

  const fileBlocks = files.map((f) => {
    const parts = [`### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`];
    if (f.numberedPatch) {
      let patch = f.numberedPatch;
      if (totalPatchChars > TOTAL_PATCH_BUDGET) {
        const budget = Math.floor((patch.length / totalPatchChars) * TOTAL_PATCH_BUDGET);
        if (patch.length > budget) patch = patch.slice(0, budget) + "\n... (truncated)";
      }
      parts.push("```diff", patch, "```");
    } else {
      parts.push("(no textual diff)");
    }
    return parts.join("\n");
  });

  const prContextBlock = buildPrContextBlock(prContext);

  return [
    `PR #${session.prRef.number}: ${prInfo.title}`,
    `Author: ${prInfo.author}`,
    `Base: ${prInfo.base} → ${prInfo.head}`,
    `Changes: +${prInfo.additions} -${prInfo.deletions}, ${prInfo.changedFiles} files`,
    ...(prContextBlock ? ["", prContextBlock] : []),
    "",
    "## Changed Files",
    "",
    fileBlocks.join("\n\n")
  ].join("\n");
}

function stripIssueSections(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inIssueSection = false;
  for (const line of lines) {
    if (/^###\s*(必須修正|建議改善)/.test(line)) { inIssueSection = true; continue; }
    if (/^###/.test(line)) { inIssueSection = false; }
    if (!inIssueSection) result.push(line);
  }
  return result.join("\n").trim();
}

function parseAiComments(raw: string): {
  analysis: string;
  comments: Array<{ context: string; severity: "must-fix" | "should-fix"; description: string; body: string; path: string | null; line: number | null }>;
} {
  const match = /```json\s*([\s\S]*?)```\s*$/.exec(raw);
  if (!match) return { analysis: raw, comments: [] };

  const analysis = stripIssueSections(raw.slice(0, match.index).trimEnd());
  try {
    const parsed = JSON.parse(match[1] ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return { analysis, comments: [] };
    const comments = parsed.flatMap((c) => {
      if (typeof c !== "object" || c === null) return [];
      const r = c as Record<string, unknown>;
      if (typeof r["context"] !== "string" || typeof r["body"] !== "string") return [];
      return [{
        context: r["context"],
        severity: r["severity"] === "should-fix" ? "should-fix" as const : "must-fix" as const,
        description: typeof r["description"] === "string" ? r["description"] : "",
        body: r["body"],
        path: typeof r["path"] === "string" ? r["path"] : null,
        line: typeof r["line"] === "number" ? r["line"] : null
      }];
    });
    return { analysis, comments };
  } catch {
    return { analysis, comments: [] };
  }
}

function groupCommentsByPath(comments: PrContext["reviewComments"]): Map<string, ExistingInlineComment[]> {
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

function stripJsonFence(text: string): string {
  return text.replace(/```json\s*[\s\S]*?```\s*$/m, "").trimEnd();
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
