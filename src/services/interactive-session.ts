import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadPrompt } from "../utils/prompt-loader.js";
import { renderToTerminal } from "../utils/terminal-renderer.js";
import { makeConversationClient, type ClientBackend } from "../clients/conversation-client.js";
import { loadArtifacts, saveSession } from "./session-store.js";
import { buildPrContextBlock, createSavedSession } from "./session.js";
import type {
  AppSession,
  SessionArtifacts,
  PrContext,
  WalkthroughCursor,
  ConversationMessage
} from "../types.js";
import type { ModelPreset } from "../types.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function writeProgress(msg: string): void {
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
  backend?: ClientBackend;
  claudeCliModel?: string;
  promptFile?: string;
  verbose?: boolean;
}

// ── Command parsing ────────────────────────────────────────────────────────

type ParsedCommand =
  | { type: "next" }
  | { type: "jump"; filePath: string }
  | { type: "status" }
  | { type: "exit" }
  | { type: "followup"; text: string };

const NEXT_RE = /^(next|下一個|continue|ok)$/i;
const JUMP_RE = /^jump\s+(.+)$/i;
const STATUS_RE = /^status$/i;
const EXIT_RE = /^(exit|quit|q)$/i;

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed) return { type: "followup", text: "" };

  if (NEXT_RE.test(trimmed)) return { type: "next" };

  const jumpMatch = JUMP_RE.exec(trimmed);
  if (jumpMatch) return { type: "jump", filePath: (jumpMatch[1] ?? "").trim() };

  if (STATUS_RE.test(trimmed)) return { type: "status" };
  if (EXIT_RE.test(trimmed)) return { type: "exit" };

  return { type: "followup", text: trimmed };
}

// ── ASCII tree ─────────────────────────────────────────────────────────────

type DirNode = { [key: string]: DirNode | null };

function insertPath(root: DirNode, parts: string[]): void {
  if (parts.length === 0) return;
  const [head, ...rest] = parts;
  if (!head) return;
  if (rest.length === 0) {
    root[head] = null;
  } else {
    if (!(head in root) || root[head] === null) {
      root[head] = {};
    }
    insertPath(root[head] as DirNode, rest);
  }
}

function renderNode(node: DirNode, prefix: string): string[] {
  const entries = Object.entries(node);
  const lines: string[] = [];
  for (const [i, [name, child]] of entries.entries()) {
    const isLast = i === entries.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    if (child === null) {
      lines.push(`${prefix}${branch}${name}`);
    } else {
      lines.push(`${prefix}${branch}${name}/`);
      lines.push(...renderNode(child, prefix + childPrefix));
    }
  }
  return lines;
}

function buildAsciiTree(filePaths: string[]): string {
  const root: DirNode = {};
  for (const p of filePaths) {
    insertPath(root, p.split("/"));
  }
  return renderNode(root, "").join("\n");
}

// ── Session creation ───────────────────────────────────────────────────────

export async function createWalkthroughSession(
  prUrl: string,
  opts: InteractiveOptions
): Promise<AppSession> {
  writeProgress("Fetching PR metadata and comments...");
  const session = await createSavedSession(prUrl, opts.githubToken, opts.model, "walkthrough");
  const artifacts = loadArtifacts(session.id);
  writeProgress(`Loaded PR #${session.prRef.number}: ${session.prTitle}`);
  writeProgress(
    `Found ${artifacts.files.length} changed file(s), ${artifacts.prContext.reviews.length} review(s), ${artifacts.prContext.issueComments.length + artifacts.prContext.reviewComments.length} comment(s).`
  );
  return session;
}


function resolvePromptPath(name: string): string {
  return join(MODULE_DIR, "..", "..", "prompts", name);
}

// ── Cursor helpers ─────────────────────────────────────────────────────────

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
    "  exit — end session",
    "",
    "IMPORTANT: Always respond in Traditional Chinese (繁體中文), regardless of the language used in the prompt or code."
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


function buildInitialWalkthroughMessage(
  session: AppSession,
  artifacts: SessionArtifacts
): string {
  const { prInfo, walkthroughOrder, files } = artifacts;
  const tree = buildAsciiTree(walkthroughOrder);

  const fileMap = new Map(files.map((f) => [f.path, f]));
  const fileTableRows = walkthroughOrder.map((p, i) => {
    const f = fileMap.get(p);
    return `${i + 1}. ${p} (${f?.status ?? "??"}, +${f?.additions ?? 0}/-${f?.deletions ?? 0})`;
  });

  const firstFilePath = walkthroughOrder[0];
  const firstFileMaterial = firstFilePath
    ? buildFileMaterialBlock(firstFilePath, artifacts)
    : "";

  const prContextBlock = buildPrContextBlock(artifacts.prContext);

  return [
    `Begin the walkthrough for PR #${session.prRef.number}: ${session.prTitle}`,
    "",
    `Author: ${prInfo.author}`,
    `Base: ${prInfo.base} → ${prInfo.head}`,
    `Changes: +${prInfo.additions} -${prInfo.deletions}, ${prInfo.changedFiles} files`,
    ...(prContextBlock ? ["", prContextBlock] : []),
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


// ── Status display ─────────────────────────────────────────────────────────

function printStatus(session: AppSession, artifacts: SessionArtifacts): void {
  writeLine(`\nSession: ${session.id} | mode: ${session.mode}`);
  writeLine(
    `PR: ${session.prRef.owner}/${session.prRef.repo}#${session.prRef.number} — ${session.prTitle}`
  );
  writeLine(`Snapshot: ${session.snapshotSha}`);

  const c = session.cursor;
  const total = c.walkthroughOrder.length;
  writeLine(`Progress: file ${c.fileIndex + 1}/${total}`);
  writeLine("");
  for (const [i, p] of c.walkthroughOrder.entries()) {
    const marker = i < c.fileIndex ? "[x]" : i === c.fileIndex ? "[>]" : "[ ]";
    writeLine(`  ${marker} ${p}`);
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

  const convClient = makeConversationClient({
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
    azureFoundryBaseUrl: opts.azureFoundryBaseUrl,
    azureFoundryApiKey: opts.azureFoundryApiKey,
    deploymentName: opts.deploymentName,
    ...(opts.claudeCliModel !== undefined ? { claudeCliModel: opts.claudeCliModel } : {}),
  });

  // Load prompt for system prompt
  const promptPath = opts.promptFile ?? resolveSessionPromptPath();
  const promptContent = await loadPrompt(promptPath);

  printSessionHeader(session);

  // If new session, generate first response
  if (isNew) {
    const initMessage = buildInitialWalkthroughMessage(session, artifacts);

    writeProgress("Generating initial overview...");

    const systemPrompt = buildWalkthroughSystemPrompt(session, artifacts, promptContent);

    const callMessages: ConversationMessage[] = [{ role: "user", content: initMessage }];
    const response = await convClient.send(systemPrompt, callMessages);

    writeLine("\n" + renderToTerminal(response) + "\n");

    session.messages.push({ role: "user", content: initMessage });
    session.messages.push({ role: "assistant", content: response });
    session.updatedAt = new Date().toISOString();
    saveSession(session);
  } else {
    // Resuming: show last assistant message as context
    const lastAssistant = session.messages.findLast((m) => m.role === "assistant");
    if (lastAssistant) {
      writeLine("(resuming session — last response:)\n");
      writeLine(renderToTerminal(lastAssistant.content) + "\n");
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
        const c = session.cursor;
        if (c.fileIndex >= c.walkthroughOrder.length - 1) {
          writeLine("(already at last file)");
          prompt();
          continue;
        }
        session.cursor = advanceWalkthroughCursor(c);
      }

      if (cmd.type === "jump") {
        const newCursor = jumpWalkthroughCursor(session.cursor, cmd.filePath);
        if (newCursor.fileIndex === session.cursor.fileIndex) {
          writeLine(`(file not found in walkthrough order: ${cmd.filePath})`);
          prompt();
          continue;
        }
        session.cursor = newCursor;
      }

      // Build context-injected user message for the model
      const c = session.cursor;
      const currentPath = c.walkthroughOrder[c.fileIndex] ?? "";
      const contextBlock = buildFileMaterialBlock(currentPath, artifacts);
      const userText =
        cmd.type === "followup"
          ? cmd.text
          : cmd.type === "jump"
            ? `[jump to file ${c.fileIndex + 1}/${c.walkthroughOrder.length}: ${currentPath}]`
            : `[next: file ${c.fileIndex + 1}/${c.walkthroughOrder.length}: ${currentPath}]`;

      const contextualMessage = `${contextBlock}\n\n${userText}`;
      const systemPrompt = buildWalkthroughSystemPrompt(session, artifacts, promptContent);

      const callMessages: ConversationMessage[] = [
        ...session.messages,
        { role: "user", content: contextualMessage }
      ];

      writeProgress("Thinking...");
      const response = await convClient.send(systemPrompt, callMessages);
      writeLine("\n" + renderToTerminal(response) + "\n");

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

function resolveSessionPromptPath(): string {
  return resolvePromptPath("branch-diff-walkthrough.md");
}
