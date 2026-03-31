import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage } from "./types.js";

function buildPrompt(system: string, messages: ConversationMessage[]): string {
  const parts = [
    "## System Instructions",
    system.trim(),
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

export class CodexCliClient {
  private readonly model: string | undefined;

  constructor(model?: string) {
    const trimmed = model?.trim();
    this.model = trimmed ? trimmed : undefined;
  }

  async send(
    system: string,
    messages: ConversationMessage[],
    _maxTokens = 2048,
    signal?: AbortSignal
  ): Promise<string> {
    const prompt = buildPrompt(system, messages);
    const tempDir = await mkdtemp(join(tmpdir(), "gh-pr-agent-codex-"));
    const outputPath = join(tempDir, "last-message.txt");

    const args = [
      "exec",
      "-",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--color", "never",
      "-o", outputPath,
    ];

    if (this.model) {
      args.push("--model", this.model);
    }

    try {
      return await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Aborted"));
          return;
        }

        const proc = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
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

        proc.on("close", async (code) => {
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted || settled) return;
          if (code !== 0) {
            rejectOnce(new Error(`codex CLI exited with code ${code}: ${(stderr || stdout).trim()}`));
            return;
          }

          try {
            const reply = (await readFile(outputPath, "utf8")).trim();
            if (!reply) {
              rejectOnce(new Error("codex CLI completed without producing a final message"));
              return;
            }
            resolveOnce(reply);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            rejectOnce(new Error(`Failed to read codex CLI output: ${message}`));
          }
        });

        proc.on("error", (error) => {
          signal?.removeEventListener("abort", onAbort);
          rejectOnce(new Error(`Failed to spawn codex CLI: ${error.message}`));
        });

        proc.stdin.end(prompt);
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
