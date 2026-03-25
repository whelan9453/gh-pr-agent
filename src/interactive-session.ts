import readline from "node:readline";
import { loadPrompt } from "./prompt-loader.js";
import { GitHubClient, parsePullRequestUrl } from "./github-client.js";
import { ClaudeFoundryClient } from "./model-client.js";
import { ReviewEngine } from "./review-engine.js";
import { buildNumberedPatch } from "./diff-line-mapper.js";
import { FoundryConversationClient } from "./conversation-client.js";
import { parseCommand } from "./command-parser.js";
import { buildWalkthroughOrder } from "./walkthrough-order.js";
import { buildAsciiTree } from "./ascii-tree.js";
import {
  generateSessionId,
  saveSession,
  loadArtifacts,
  saveArtifacts
} from "./session-store.js";
import type {
  AppSession,
  SessionArtifacts,
  FileMaterial,
  WalkthroughCursor,
  ReviewCursor,
  ConversationMessage,
  SessionMode
} from "./types.js";
import { resolveConfig } from "./config.js";
import type { ModelPreset } from "./config.js";

function writeProgress(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function writeLine(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

export interface InteractiveOptions {
  model: ModelPreset;
  githubToken: string;
  azureFoundryBaseUrl: string;
  azureFoundryApiKey: string;
  deploymentName: string;
  promptFile?: string;
  verbose?: boolean;
}

// ── Session creation ───────────────────────────────────────────────────────

export async function createWalkthroughSession(
  prUrl: string,
  opts: InteractiveOptions
): Promise<AppSession> {
  const pr = parsePullRequestUrl(prUrl);
  const github = new GitHubClient(opts.githubToken, pr.apiBaseUrl);

  writeProgress("Fetching PR metadata...");
  const prInfo = await github.getPullRequest(pr);
  writeProgress(`Loaded PR #${pr.number}: ${prInfo.title}`);
  writeProgress("Fetching changed files...");
  const changedFiles = await github.listPullRequestFiles(pr);
  writeProgress(`Found ${changedFiles.length} changed file(s).`);

  writeProgress("Building file materials...");
  const files: FileMaterial[] = changedFiles.map((f) => ({
    path: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    numberedPatch: f.patch ? buildNumberedPatch(f.patch).numberedPatch : null
  }));

  const walkthroughOrder = buildWalkthroughOrder(files.map((f) => f.path));

  const artifacts: SessionArtifacts = { prInfo, files, walkthroughOrder };

  const id = generateSessionId();
  const now = new Date().toISOString();

  const cursor: WalkthroughCursor = {
    mode: "walkthrough",
    fileIndex: 0,
    walkthroughOrder
  };

  const session: AppSession = {
    id,
    mode: "walkthrough",
    prRef: pr,
    model: opts.model,
    prTitle: prInfo.title,
    snapshotSha: prInfo.headSha,
    createdAt: now,
    updatedAt: now,
    cursor,
    messages: []
  };

  // Atomically save: artifacts first, then session
  saveArtifacts(id, artifacts);
  saveSession(session);

  return session;
}

export async function createReviewSession(
  prUrl: string,
  opts: InteractiveOptions
): Promise<AppSession> {
  const pr = parsePullRequestUrl(prUrl);
  const github = new GitHubClient(opts.githubToken, pr.apiBaseUrl);

  writeProgress("Fetching PR metadata...");
  const prInfo = await github.getPullRequest(pr);
  writeProgress(`Loaded PR #${pr.number}: ${prInfo.title}`);

  // Run full ReviewEngine precompute
  writeProgress("Running precompute review (this may take a moment)...");
  const reviewPromptPath = await resolveDefaultReviewPromptPath();
  const reviewPrompt = await loadPrompt(reviewPromptPath);

  const foundryClient = new ClaudeFoundryClient(
    opts.azureFoundryBaseUrl,
    opts.azureFoundryApiKey,
    opts.deploymentName,
    opts.verbose ? { onVerbose: writeProgress } : undefined
  );

  const engine = new ReviewEngine(github, foundryClient, reviewPrompt, {
    onProgress: writeProgress,
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {})
  });

  const reviewReport = await engine.reviewPullRequest(pr);
  writeProgress("Precompute complete.");

  const files: FileMaterial[] = reviewReport.files.map((f) => ({
    path: f.path,
    status: f.status,
    additions: 0,
    deletions: 0,
    numberedPatch: null
  }));

  const walkthroughOrder = buildWalkthroughOrder(files.map((f) => f.path));
  const artifacts: SessionArtifacts = { prInfo, files, walkthroughOrder, reviewReport };

  const id = generateSessionId();
  const now = new Date().toISOString();

  // Start cursor at first file with content
  const firstFileIndex = findNextReviewFile(reviewReport.files, -1);

  const cursor: ReviewCursor = {
    mode: "review",
    fileIndex: Math.max(0, firstFileIndex),
    issueIndex: -1
  };

  const session: AppSession = {
    id,
    mode: "review",
    prRef: pr,
    model: opts.model,
    prTitle: prInfo.title,
    snapshotSha: prInfo.headSha,
    createdAt: now,
    updatedAt: now,
    cursor,
    messages: []
  };

  saveArtifacts(id, artifacts);
  saveSession(session);

  return session;
}

async function resolveDefaultReviewPromptPath(): Promise<string> {
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const url = import.meta.url;
  const dir = dirname(fileURLToPath(url));
  return `${dir}/../prompts/review_prompt.md`;
}

// ── Cursor helpers ─────────────────────────────────────────────────────────

function findNextReviewFile(
  files: NonNullable<SessionArtifacts["reviewReport"]>["files"],
  currentIndex: number
): number {
  for (let i = currentIndex + 1; i < files.length; i++) {
    const f = files[i];
    if (!f) continue;
    if (!f.skipped && !f.reviewFailed && (f.issues.length > 0 || f.summary.length > 0)) {
      return i;
    }
  }
  // If no file with content found, just go to next file
  return Math.min(currentIndex + 1, files.length - 1);
}

function advanceReviewCursor(cursor: ReviewCursor, artifacts: SessionArtifacts): ReviewCursor {
  const report = artifacts.reviewReport;
  if (!report) return cursor;

  const currentFile = report.files[cursor.fileIndex];
  const hasIssues = currentFile && currentFile.issues.length > 0;

  if (hasIssues && cursor.issueIndex < (currentFile?.issues.length ?? 0) - 1) {
    return { ...cursor, issueIndex: cursor.issueIndex + 1 };
  }

  const nextFileIndex = findNextReviewFile(report.files, cursor.fileIndex);
  return { ...cursor, fileIndex: nextFileIndex, issueIndex: -1 };
}

function advanceWalkthroughCursor(cursor: WalkthroughCursor): WalkthroughCursor {
  const next = Math.min(cursor.fileIndex + 1, cursor.walkthroughOrder.length - 1);
  return { ...cursor, fileIndex: next };
}

function jumpWalkthroughCursor(cursor: WalkthroughCursor, filePath: string): WalkthroughCursor {
  const index = cursor.walkthroughOrder.findIndex(
    (p) => p === filePath || p.endsWith(filePath) || filePath.endsWith(p)
  );
  if (index < 0) return cursor;
  return { ...cursor, fileIndex: index };
}

function jumpReviewCursor(
  cursor: ReviewCursor,
  artifacts: SessionArtifacts,
  filePath: string
): ReviewCursor {
  const report = artifacts.reviewReport;
  if (!report) return cursor;
  const index = report.files.findIndex(
    (f) => f.path === filePath || f.path.endsWith(filePath) || filePath.endsWith(f.path)
  );
  if (index < 0) return cursor;
  return { ...cursor, fileIndex: index, issueIndex: -1 };
}

// ── Context builders ───────────────────────────────────────────────────────

function buildWalkthroughSystemPrompt(
  session: AppSession,
  artifacts: SessionArtifacts,
  promptContent: string
): string {
  const c = session.cursor as WalkthroughCursor;
  const currentPath = c.walkthroughOrder[c.fileIndex] ?? "unknown";
  const total = c.walkthroughOrder.length;

  const orderedList = c.walkthroughOrder
    .map((p, i) => `  ${i + 1}. ${p}`)
    .join("\n");

  return [
    promptContent,
    "",
    "---",
    `Session: ${session.id}`,
    `Mode: walkthrough`,
    `PR: ${session.prRef.owner}/${session.prRef.repo}#${session.prRef.number} — ${session.prTitle}`,
    `Branch: ${artifacts.prInfo.base} → ${artifacts.prInfo.head}`,
    `Current position: file ${c.fileIndex + 1}/${total} — ${currentPath}`,
    "",
    "IMPORTANT: The file review order has been predetermined by the app. You MUST follow",
    "this exact order and MUST NOT reorder files based on your own judgment:",
    orderedList,
    "",
    "When the user types next/ok/continue/下一個, advance to the next file in the list above.",
    "When the user jumps to a file, review that specific file.",
    "",
    "Available commands the user may type:",
    "  next / ok / continue / 下一個 — move to next file",
    "  jump <file-path> — jump to a specific file",
    "  status — show current position (no model response needed)",
    "  exit — end session"
  ].join("\n");
}

function buildReviewSystemPrompt(
  session: AppSession,
  artifacts: SessionArtifacts,
  promptContent: string
): string {
  const c = session.cursor as ReviewCursor;
  const report = artifacts.reviewReport;
  const currentFile = report?.files[c.fileIndex];
  const total = report?.files.length ?? 0;

  return [
    promptContent,
    "",
    "---",
    `Session: ${session.id}`,
    `Mode: interactive review`,
    `PR: ${session.prRef.owner}/${session.prRef.repo}#${session.prRef.number} — ${session.prTitle}`,
    `Branch: ${artifacts.prInfo.base} → ${artifacts.prInfo.head}`,
    `Current position: file ${c.fileIndex + 1}/${total}${currentFile ? ` — ${currentFile.path}` : ""}${c.issueIndex >= 0 ? `, issue ${c.issueIndex + 1}/${currentFile?.issues.length ?? 0}` : ""}`,
    "",
    "You are presenting a precomputed structured review. Present findings from the ReviewReport.",
    "For files marked reviewFailed or skipped, acknowledge the failure — do NOT invent analysis.",
    "",
    "Available commands:",
    "  next — advance to next issue or next file",
    "  jump <file-path> — jump to specific file",
    "  status — show current position",
    "  exit — end session"
  ].join("\n");
}

function buildFileMaterialBlock(filePath: string, artifacts: SessionArtifacts): string {
  const file = artifacts.files.find((f) => f.path === filePath);
  if (!file) return `File: ${filePath} (material not available)`;

  const parts = [
    `File: ${file.path}`,
    `Status: ${file.status}`,
    `Additions: ${file.additions}  Deletions: ${file.deletions}`
  ];

  if (file.numberedPatch) {
    parts.push("", "Patch:", file.numberedPatch);
  } else {
    parts.push("(No patch available — file may be binary or have no textual diff)");
  }

  return parts.join("\n");
}

function buildReviewFileMaterialBlock(
  fileIndex: number,
  issueIndex: number,
  artifacts: SessionArtifacts
): string {
  const report = artifacts.reviewReport;
  if (!report) return "(No review report available)";

  const file = report.files[fileIndex];
  if (!file) return "(File not found in report)";

  const parts = [`File: ${file.path}`, `Status: ${file.status}`];

  if (file.skipped) {
    parts.push(`Skipped: ${file.skipReason ?? "no reason"}`);
    return parts.join("\n");
  }

  if (file.reviewFailed) {
    parts.push(`Review failed: ${file.reviewFailureReason ?? "unknown error"}`);
    return parts.join("\n");
  }

  if (file.summary.length > 0) {
    parts.push("", "Summary:", ...file.summary.map((s) => `• ${s}`));
  }

  if (issueIndex >= 0 && issueIndex < file.issues.length) {
    const issue = file.issues[issueIndex];
    if (issue) {
      parts.push(
        "",
        `Issue ${issueIndex + 1}/${file.issues.length}: ${issue.title}`,
        `Severity: ${issue.severity}  Confidence: ${issue.confidence}${issue.line ? `  Line: ${issue.line}` : ""}`,
        "",
        issue.details
      );
    }
  } else if (file.issues.length > 0) {
    parts.push("", `Issues (${file.issues.length} total):`);
    for (const [i, issue] of file.issues.entries()) {
      parts.push(
        `  ${i + 1}. [${issue.severity}] ${issue.title}${issue.line ? ` (line ${issue.line})` : ""}`
      );
    }
  }

  return parts.join("\n");
}

function buildInitialWalkthroughMessage(
  session: AppSession,
  artifacts: SessionArtifacts
): string {
  const { prInfo, walkthroughOrder, files } = artifacts;
  const tree = buildAsciiTree(walkthroughOrder);

  const fileTableRows = walkthroughOrder.map((p, i) => {
    const f = files.find((f) => f.path === p);
    return `${i + 1}. ${p} (${f?.status ?? "??"}, +${f?.additions ?? 0}/-${f?.deletions ?? 0})`;
  });

  const firstFilePath = walkthroughOrder[0];
  const firstFileMaterial = firstFilePath
    ? buildFileMaterialBlock(firstFilePath, artifacts)
    : "";

  return [
    `Begin the walkthrough for PR #${session.prRef.number}: ${session.prTitle}`,
    "",
    `Author: ${prInfo.author}`,
    `Base: ${prInfo.base} → ${prInfo.head}`,
    `Changes: +${prInfo.additions} -${prInfo.deletions}, ${prInfo.changedFiles} files`,
    "",
    "Changed files — follow this exact order, do NOT reorder:",
    "```",
    tree,
    "```",
    "",
    ...fileTableRows,
    "",
    `Now review File 1/${walkthroughOrder.length}: ${firstFilePath ?? "(none)"}`,
    "",
    firstFileMaterial
  ].join("\n");
}

function buildInitialReviewMessage(session: AppSession, artifacts: SessionArtifacts): string {
  const report = artifacts.reviewReport;
  if (!report) return "No review report available.";

  const c = session.cursor as ReviewCursor;
  const fileLines = report.files.map((f, i) => {
    if (f.skipped) return `  ${i + 1}. ${f.path} — SKIPPED`;
    if (f.reviewFailed) return `  ${i + 1}. ${f.path} — REVIEW FAILED`;
    return `  ${i + 1}. ${f.path} — ${f.issues.length} issue(s)`;
  });

  const currentFile = report.files[c.fileIndex];
  const currentMaterial = buildReviewFileMaterialBlock(c.fileIndex, c.issueIndex, artifacts);

  return [
    `Begin interactive review for PR #${session.prRef.number}: ${session.prTitle}`,
    "",
    `Author: ${artifacts.prInfo.author}`,
    `Base: ${artifacts.prInfo.base} → ${artifacts.prInfo.head}`,
    `Summary: ${report.overallSummary}`,
    "",
    "Files:",
    ...fileLines,
    "",
    `Starting with file ${c.fileIndex + 1}/${report.files.length}: ${currentFile?.path ?? "(none)"}`,
    "",
    currentMaterial
  ].join("\n");
}

// ── Status display ─────────────────────────────────────────────────────────

function printStatus(session: AppSession, artifacts: SessionArtifacts): void {
  writeLine(`\nSession: ${session.id} | mode: ${session.mode}`);
  writeLine(
    `PR: ${session.prRef.owner}/${session.prRef.repo}#${session.prRef.number} — ${session.prTitle}`
  );
  writeLine(`Snapshot: ${session.snapshotSha}`);

  if (session.cursor.mode === "walkthrough") {
    const c = session.cursor;
    const total = c.walkthroughOrder.length;
    writeLine(`Progress: file ${c.fileIndex + 1}/${total}`);
    writeLine("");
    for (const [i, p] of c.walkthroughOrder.entries()) {
      const marker = i < c.fileIndex ? "[x]" : i === c.fileIndex ? "[>]" : "[ ]";
      writeLine(`  ${marker} ${p}`);
    }
  } else {
    const c = session.cursor as ReviewCursor;
    const report = artifacts.reviewReport;
    const total = report?.files.length ?? 0;
    const currentFile = report?.files[c.fileIndex];
    writeLine(
      `Progress: file ${c.fileIndex + 1}/${total} — ${currentFile?.path ?? "?"}${c.issueIndex >= 0 ? `, issue ${c.issueIndex + 1}/${currentFile?.issues.length ?? 0}` : ""}`
    );
  }

  writeLine(`\nCommands: next | jump <path> | status | exit\n`);
}

// ── Session header ─────────────────────────────────────────────────────────

function printSessionHeader(session: AppSession): void {
  writeLine("");
  writeLine(`╔══════════════════════════════════════════════════════╗`);
  writeLine(`  Session: ${session.id}`);
  writeLine(`  Mode:    ${session.mode}`);
  writeLine(`  PR:      ${session.prRef.owner}/${session.prRef.repo}#${session.prRef.number}`);
  writeLine(`           ${session.prTitle}`);
  writeLine(`  Model:   ${session.model}`);
  writeLine(`╚══════════════════════════════════════════════════════╝`);
  writeLine(`Commands: next | jump <path> | status | exit`);
  writeLine(`Resume:   gh-pr-review resume ${session.id}`);
  writeLine("");
}

// ── REPL ───────────────────────────────────────────────────────────────────

export async function runSessionRepl(
  session: AppSession,
  opts: InteractiveOptions,
  isNew: boolean
): Promise<void> {
  const artifacts = loadArtifacts(session.id);

  const convClient = new FoundryConversationClient(
    opts.azureFoundryBaseUrl,
    opts.azureFoundryApiKey,
    opts.deploymentName
  );

  // Load prompt for system prompt
  const promptPath = opts.promptFile ?? (await resolveSessionPromptPath(session.mode));
  const promptContent = await loadPrompt(promptPath);

  printSessionHeader(session);

  // If new session, generate first response
  if (isNew) {
    const initMessage =
      session.mode === "walkthrough"
        ? buildInitialWalkthroughMessage(session, artifacts)
        : buildInitialReviewMessage(session, artifacts);

    writeProgress("Generating initial overview...");

    const systemPrompt =
      session.mode === "walkthrough"
        ? buildWalkthroughSystemPrompt(session, artifacts, promptContent)
        : buildReviewSystemPrompt(session, artifacts, promptContent);

    const callMessages: ConversationMessage[] = [{ role: "user", content: initMessage }];
    const response = await convClient.send(systemPrompt, callMessages);

    writeLine("\n" + response + "\n");

    session.messages.push({ role: "user", content: initMessage });
    session.messages.push({ role: "assistant", content: response });
    session.updatedAt = new Date().toISOString();
    saveSession(session);
  } else {
    // Resuming: show last assistant message as context
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) {
      writeLine("(resuming session — last response:)\n");
      writeLine(lastAssistant.content + "\n");
    }
    printStatus(session, artifacts);
  }

  // REPL loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  const prompt = (): void => {
    process.stdout.write("\n> ");
  };

  prompt();

  for await (const line of rl) {
    const cmd = parseCommand(line);

    if (cmd.type === "exit") {
      writeLine("Session saved. Goodbye.");
      rl.close();
      break;
    }

    if (cmd.type === "status") {
      printStatus(session, artifacts);
      prompt();
      continue;
    }

    if (cmd.type === "next" || cmd.type === "jump" || cmd.type === "followup") {
      // Update cursor for next/jump
      if (cmd.type === "next") {
        if (session.cursor.mode === "walkthrough") {
          const c = session.cursor as WalkthroughCursor;
          if (c.fileIndex >= c.walkthroughOrder.length - 1) {
            writeLine("(already at last file)");
            prompt();
            continue;
          }
          session.cursor = advanceWalkthroughCursor(c);
        } else {
          session.cursor = advanceReviewCursor(session.cursor as ReviewCursor, artifacts);
        }
      }

      if (cmd.type === "jump") {
        if (session.cursor.mode === "walkthrough") {
          const newCursor = jumpWalkthroughCursor(
            session.cursor as WalkthroughCursor,
            cmd.filePath
          );
          if (
            newCursor.fileIndex === (session.cursor as WalkthroughCursor).fileIndex
          ) {
            writeLine(`(file not found in walkthrough order: ${cmd.filePath})`);
            prompt();
            continue;
          }
          session.cursor = newCursor;
        } else {
          const newCursor = jumpReviewCursor(
            session.cursor as ReviewCursor,
            artifacts,
            cmd.filePath
          );
          if (newCursor.fileIndex === (session.cursor as ReviewCursor).fileIndex) {
            writeLine(`(file not found: ${cmd.filePath})`);
            prompt();
            continue;
          }
          session.cursor = newCursor;
        }
      }

      // Build context-injected user message for the model
      let contextBlock: string;
      let userText: string;

      if (session.cursor.mode === "walkthrough") {
        const c = session.cursor as WalkthroughCursor;
        const currentPath = c.walkthroughOrder[c.fileIndex] ?? "";
        contextBlock = buildFileMaterialBlock(currentPath, artifacts);
        userText =
          cmd.type === "followup"
            ? cmd.text
            : cmd.type === "jump"
              ? `[jump to file ${c.fileIndex + 1}/${c.walkthroughOrder.length}: ${currentPath}]`
              : `[next: file ${c.fileIndex + 1}/${c.walkthroughOrder.length}: ${currentPath}]`;
      } else {
        const c = session.cursor as ReviewCursor;
        contextBlock = buildReviewFileMaterialBlock(c.fileIndex, c.issueIndex, artifacts);
        userText =
          cmd.type === "followup"
            ? cmd.text
            : cmd.type === "jump"
              ? `[jump to file ${c.fileIndex + 1}]`
              : `[next]`;
      }

      const contextualMessage = `${contextBlock}\n\n${userText}`;
      const systemPrompt =
        session.cursor.mode === "walkthrough"
          ? buildWalkthroughSystemPrompt(session, artifacts, promptContent)
          : buildReviewSystemPrompt(session, artifacts, promptContent);

      const callMessages: ConversationMessage[] = [
        ...session.messages,
        { role: "user", content: contextualMessage }
      ];

      writeProgress("Thinking...");
      const response = await convClient.send(systemPrompt, callMessages);
      writeLine("\n" + response + "\n");

      // Save the user-visible text and response for session history
      const savedUserContent = cmd.type === "followup" ? cmd.text : userText;
      session.messages.push({ role: "user", content: savedUserContent });
      session.messages.push({ role: "assistant", content: response });
      session.updatedAt = new Date().toISOString();
      saveSession(session);
    }

    prompt();
  }
}

async function resolveSessionPromptPath(mode: SessionMode): Promise<string> {
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const dir = dirname(fileURLToPath(import.meta.url));
  if (mode === "walkthrough") {
    return join(dir, "..", "prompts", "branch-diff-walkthrough.md");
  }
  return join(dir, "..", "prompts", "review_chat.md");
}
