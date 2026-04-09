import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubClient } from "../clients/github-client.js";
import { getBatchPatchBudget, getTotalPatchBudget } from "../config.js";
import {
  gitRemoteMatchesPr,
  isCodexCliAvailable,
  isGitRepo,
  runCodexLocalReview
} from "../utils/local-repo-check.js";
import { loadPrompt } from "../utils/prompt-loader.js";
import type { ConversationClient } from "../clients/conversation-client.js";
import {
  loadArtifacts,
  loadSession,
  saveArtifacts,
  saveSession
} from "./session-store.js";
import { buildPrContextBlock, groupCommentsByPath } from "./session.js";
import type {
  AppSession,
  ConversationMessage,
  FileMaterial,
  ReviewSubmissionPayload,
  SessionArtifacts
} from "../types.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

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
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  backendLabel = "AI"
): Promise<{ analysis: string; draftCount: number; comments: Array<{ context: string; severity: "must-fix" | "should-fix"; description: string; body: string; path: string | null; line: number | null; alreadyTracked?: boolean }> }> {
  onProgress?.("載入 PR 資料...");
  const session = loadSession(sessionId);
  const artifacts = loadArtifacts(sessionId);

  const fileCount = artifacts.files.length;
  const totalPatchChars = artifacts.files.reduce((s, f) => s + (f.numberedPatch?.length ?? 0), 0);

  if (totalPatchChars > getTotalPatchBudget()) {
    return runBatchedAiReview(sessionId, session, artifacts, client, onProgress, signal, backendLabel);
  }

  onProgress?.("載入分析提示詞...");
  const systemPrompt = await loadPrompt(join(MODULE_DIR, "..", "..", "prompts", "pr-summary.md"));

  const totalChanges = artifacts.files.reduce((s, f) => s + f.additions + f.deletions, 0);
  onProgress?.(`組合差異內容（${fileCount} 個檔案，${totalChanges} 行變更）...`);
  const userMessage = buildAiReviewMessage(session, artifacts);
  const messages: ConversationMessage[] = [{ role: "user", content: userMessage }];

  onProgress?.(`傳送至 ${backendLabel}，等待回應...`);
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    onProgress?.(`${backendLabel} 仍在執行，已等待 ${formatElapsed(elapsedSeconds)}...`);
  }, 15_000);
  const raw = await client.send(systemPrompt, messages, 16384, signal)
    .finally(() => {
      clearInterval(heartbeat);
    });

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

async function runBatchedAiReview(
  sessionId: string,
  session: AppSession,
  artifacts: SessionArtifacts,
  client: ConversationClient,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  backendLabel = "AI"
): Promise<{ analysis: string; draftCount: number; comments: Array<{ context: string; severity: "must-fix" | "should-fix"; description: string; body: string; path: string | null; line: number | null; alreadyTracked?: boolean }> }> {
  const batches = splitIntoBatchesBySize(artifacts.files, getBatchPatchBudget());
  const totalBatches = batches.length;

  // Start codex local review concurrently — silently skipped if prerequisites not met
  const cwd = process.cwd();
  const codexPromise: Promise<string | null> = (async () => {
    const [repoMatch, codexAvailable] = await Promise.all([
      isGitRepo(cwd).then((ok) =>
        ok ? gitRemoteMatchesPr(cwd, session.prRef.owner, session.prRef.repo) : false
      ),
      isCodexCliAvailable()
    ]);
    if (!repoMatch || !codexAvailable) return null;
    return runCodexLocalReview(artifacts.prInfo.base, signal);
  })();

  onProgress?.("載入分析提示詞...");
  const [batchSystemPrompt, synthesizeSystemPrompt] = await Promise.all([
    loadPrompt(join(MODULE_DIR, "..", "..", "prompts", "pr-batch-review.md")),
    loadPrompt(join(MODULE_DIR, "..", "..", "prompts", "pr-synthesize.md"))
  ]);

  onProgress?.(`將 ${artifacts.files.length} 個檔案分成 ${totalBatches} 批次進行分析...`);

  const allBatchComments: RawComment[][] = [];

  for (let i = 0; i < batches.length; i++) {
    if (signal?.aborted) break;

    const batch = batches[i]!;
    const fileNames = batch.map((f) => f.path).join(", ");
    onProgress?.(`分析第 ${i + 1}/${totalBatches} 批次（${batch.length} 個檔案）...`);

    const batchMessage = buildBatchMessage(session, artifacts, batch);
    const raw = await client.send(
      batchSystemPrompt,
      [{ role: "user", content: batchMessage }],
      8192,
      signal
    );
    const comments = parseJsonCommentBlock(raw);
    allBatchComments.push(comments);

    if (comments.length > 0) {
      onProgress?.(`第 ${i + 1} 批次找到 ${comments.length} 個問題（${fileNames}）`);
    }
  }

  if (signal?.aborted) {
    return { analysis: "", draftCount: 0, comments: [] };
  }

  const localCodexOutput = await codexPromise;
  if (localCodexOutput) {
    onProgress?.("已取得 Codex Review 結果，納入合成分析");
  }

  onProgress?.(`合成 ${totalBatches} 批次的分析結果...`);
  const synthesizeMessage = buildSynthesizeMessage(session, artifacts, batches, allBatchComments, localCodexOutput);

  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    onProgress?.(`${backendLabel} 合成中，已等待 ${formatElapsed(elapsedSeconds)}...`);
  }, 15_000);
  const synthesizeRaw = await client.send(
    synthesizeSystemPrompt,
    [{ role: "user", content: synthesizeMessage }],
    16384,
    signal
  ).finally(() => {
    clearInterval(heartbeat);
  });

  onProgress?.("解析分析結果...");
  const { analysis, comments } = parseAiComments(synthesizeRaw);

  const updated = loadArtifacts(sessionId);
  updated.chatHistory = [
    { role: "user", content: synthesizeMessage },
    { role: "assistant", content: synthesizeRaw }
  ];
  saveArtifacts(sessionId, updated);

  return { analysis, draftCount: 0, comments };
}

// ~50k tokens at 4 chars/token — leaves room for system prompt and 3000-token output reserve
const MAX_CHAT_INPUT_CHARS = 200_000;

function trimChatHistory(
  history: ConversationMessage[],
  maxChars: number
): ConversationMessage[] {
  if (history.length === 0) return history;

  const anchor = history[0]!; // PR context — always keep
  const rest = history.slice(1);

  let used = anchor.content.length;
  const kept: ConversationMessage[] = [];

  // Walk newest → oldest, keep what fits within budget
  for (let i = rest.length - 1; i >= 0; i--) {
    const msg = rest[i]!;
    if (used + msg.content.length > maxChars) break;
    used += msg.content.length;
    kept.unshift(msg);
  }

  return [anchor, ...kept];
}

export async function sendChatMessage(
  sessionId: string,
  message: string,
  client: ConversationClient
): Promise<{ reply: string }> {
  const artifacts = loadArtifacts(sessionId);
  const systemPrompt = await loadPrompt(join(MODULE_DIR, "..", "..", "prompts", "pr-chat.md"));

  let history: ConversationMessage[] = artifacts.chatHistory ?? [];
  if (history.length === 0) {
    const session = loadSession(sessionId);
    history = [{ role: "user", content: buildAiReviewMessage(session, artifacts) }];
  }
  const trimmed = trimChatHistory(history, MAX_CHAT_INPUT_CHARS);
  const messages: ConversationMessage[] = [...trimmed, { role: "user", content: message }];
  const reply = await client.send(systemPrompt, messages, 3000);

  artifacts.chatHistory = [...messages, { role: "assistant", content: reply }];
  saveArtifacts(sessionId, artifacts);

  return { reply };
}

type RawComment = { context: string; severity: "must-fix" | "should-fix"; description: string; body: string; path: string | null; line: number | null; alreadyTracked?: boolean };

function splitIntoBatchesBySize(files: FileMaterial[], budgetPerBatch: number): FileMaterial[][] {
  const batches: FileMaterial[][] = [];
  let current: FileMaterial[] = [];
  let currentSize = 0;

  for (const file of files) {
    const fileSize = file.numberedPatch?.length ?? 0;
    if (current.length > 0 && currentSize + fileSize > budgetPerBatch) {
      batches.push(current);
      current = [file];
      currentSize = fileSize;
    } else {
      current.push(file);
      currentSize += fileSize;
    }
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

function buildBatchMessage(session: AppSession, artifacts: SessionArtifacts, batchFiles: FileMaterial[]): string {
  const { prInfo, prContext } = artifacts;
  const patchLengths = batchFiles.map((f) => f.numberedPatch?.length ?? 0);
  const budgets = allocateFilePatchBudgets(patchLengths, getBatchPatchBudget());

  const fileBlocks = batchFiles.map((f, i) => {
    const parts = [`### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`];
    if (f.numberedPatch) {
      const budget = budgets[i] ?? 0;
      const patch =
        f.numberedPatch.length > budget
          ? f.numberedPatch.slice(0, budget) + "\n... (truncated)"
          : f.numberedPatch;
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
    ...(prContextBlock ? ["", prContextBlock] : []),
    "",
    "## Changed Files (this batch)",
    "",
    fileBlocks.join("\n\n")
  ].join("\n");
}

function buildSynthesizeMessage(
  session: AppSession,
  artifacts: SessionArtifacts,
  batches: FileMaterial[][],
  allBatchComments: RawComment[][],
  localCodexOutput?: string | null
): string {
  const { prInfo, prContext } = artifacts;

  const allFilesBlock = artifacts.files
    .map((f) => `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`)
    .join("\n");

  const batchSections = batches.map((batch, i) => {
    const fileList = batch.map((f) => f.path).join(", ");
    const comments = allBatchComments[i] ?? [];
    return [
      `### Batch ${i + 1} (${batch.length} files: ${fileList})`,
      "```json",
      JSON.stringify(comments, null, 2),
      "```"
    ].join("\n");
  });

  const prContextBlock = buildPrContextBlock(prContext);

  return [
    `PR #${session.prRef.number}: ${prInfo.title}`,
    `Author: ${prInfo.author}`,
    `Base: ${prInfo.base} → ${prInfo.head}`,
    `Changes: +${prInfo.additions} -${prInfo.deletions}, ${prInfo.changedFiles} files`,
    ...(prContextBlock ? ["", prContextBlock] : []),
    "",
    "## All Changed Files",
    "",
    allFilesBlock,
    "",
    "## Per-Batch Findings",
    "",
    batchSections.join("\n\n"),
    ...(localCodexOutput
      ? ["", "## Local Code Analysis (Codex Review)", "", localCodexOutput]
      : [])
  ].join("\n");
}

const MIN_PER_FILE_PATCH_CHARS = 3_000;

function allocateFilePatchBudgets(patchLengths: number[], totalBudget: number): number[] {
  const total = patchLengths.reduce((s, n) => s + n, 0);
  if (total <= totalBudget) return [...patchLengths];

  const count = patchLengths.length;
  // Floor: at least MIN_PER_FILE_PATCH_CHARS, but never more than an equal share of the budget
  const floor = Math.min(MIN_PER_FILE_PATCH_CHARS, Math.floor(totalBudget / count));

  return patchLengths.map((len) => {
    const proportional = Math.floor((len / total) * totalBudget);
    return Math.max(floor, proportional);
  });
}

function buildAiReviewMessage(session: AppSession, artifacts: SessionArtifacts): string {
  const { prInfo, prContext, files } = artifacts;
  const totalPatchBudget = getTotalPatchBudget();

  const patchLengths = files.map((f) => f.numberedPatch?.length ?? 0);
  const budgets = allocateFilePatchBudgets(patchLengths, totalPatchBudget);

  const fileBlocks = files.map((f, i) => {
    const parts = [`### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`];
    if (f.numberedPatch) {
      const budget = budgets[i] ?? 0;
      const patch =
        f.numberedPatch.length > budget
          ? f.numberedPatch.slice(0, budget) + "\n... (truncated)"
          : f.numberedPatch;
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

function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分鐘` : `${minutes} 分 ${seconds} 秒`;
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

function parseJsonCommentBlock(raw: string): RawComment[] {
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

function parseAiComments(raw: string): { analysis: string; comments: RawComment[] } {
  const match = /```json\s*([\s\S]*?)```\s*$/.exec(raw);
  if (!match) return { analysis: raw, comments: [] };
  const analysis = stripIssueSections(raw.slice(0, match.index).trimEnd());
  return { analysis, comments: parseJsonCommentBlock(raw) };
}
