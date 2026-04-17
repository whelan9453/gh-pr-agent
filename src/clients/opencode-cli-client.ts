import { spawn } from "node:child_process";
import type { ConversationMessage } from "../types.js";

const DEFAULT_OPENCODE_MODEL = "github-copilot/claude-sonnet-4.6";

interface OpenCodeJsonEvent {
  type?: string;
  part?: {
    type?: string;
    text?: string;
  };
}

function buildPrompt(system: string, messages: ConversationMessage[]): string {
  const parts = [
    "## System Instructions",
    system.trim(),
    "",
    "## Runtime Constraint",
    "Use only the context in this prompt. Do not use tools, shell commands, file reads, file writes, web access, or any other external actions.",
    "",
    "## Conversation"
  ];

  if (messages.length === 0) {
    parts.push("(no prior messages)");
  } else {
    for (const message of messages) {
      parts.push("");
      parts.push(`### ${message.role === "user" ? "User" : "Assistant"}`);
      parts.push(message.content);
    }
  }

  parts.push(
    "",
    "## Task",
    "Write only the assistant's next reply for this conversation. Do not add extra framing."
  );

  return parts.join("\n");
}

function extractTextFromJsonEvents(stdout: string): string {
  const chunks: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: OpenCodeJsonEvent;
    try {
      event = JSON.parse(trimmed) as OpenCodeJsonEvent;
    } catch {
      continue;
    }

    if (event.type === "text" && event.part?.type === "text" && typeof event.part.text === "string") {
      chunks.push(event.part.text);
    }
  }

  return chunks.join("").trim();
}

export class OpenCodeCliClient {
  private readonly model: string;

  constructor(model?: string) {
    const trimmed = model?.trim();
    this.model = trimmed ? trimmed : DEFAULT_OPENCODE_MODEL;
  }

  send(
    system: string,
    messages: ConversationMessage[],
    _maxTokens = 2048,
    signal?: AbortSignal
  ): Promise<string> {
    const prompt = buildPrompt(system, messages);
    const args = ["run", "--format", "json", "--model", this.model];

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Aborted"));
        return;
      }

      const proc = spawn("opencode", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const resolveOnce = (value: string) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const onAbort = () => {
        proc.kill();
        rejectOnce(new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted || settled) return;
        if (code !== 0) {
          rejectOnce(new Error(`opencode CLI exited with code ${code}: ${(stderr || stdout).trim()}`));
          return;
        }

        const reply = extractTextFromJsonEvents(stdout);
        if (!reply) {
          rejectOnce(new Error("opencode CLI completed without producing a final message"));
          return;
        }
        resolveOnce(reply);
      });

      proc.on("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        rejectOnce(new Error(`Failed to spawn opencode CLI: ${error.message}`));
      });

      proc.stdin.end(prompt);
    });
  }
}
