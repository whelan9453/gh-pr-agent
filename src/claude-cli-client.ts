import { spawn } from "node:child_process";
import type { ConversationMessage } from "./types.js";

function buildPrompt(messages: ConversationMessage[]): string {
  if (messages.length === 1 && messages[0] !== undefined) {
    return messages[0].content;
  }
  return messages
    .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

export class ClaudeCliClient {
  private readonly model: string;

  constructor(model = "claude-sonnet-4-6") {
    this.model = model;
  }

  send(
    system: string,
    messages: ConversationMessage[],
    _maxTokens = 2048
  ): Promise<string> {
    const prompt = buildPrompt(messages);

    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", this.model,
      "--system-prompt", system,
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn("claude", args);
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`claude CLI exited with code ${code}: ${stderr.trim()}`));
          return;
        }
        let parsed: { is_error: boolean; result: string };
        try {
          parsed = JSON.parse(stdout.trim()) as typeof parsed;
        } catch {
          reject(new Error(`Failed to parse claude CLI output: ${stdout.trim()}`));
          return;
        }
        if (parsed.is_error) {
          reject(new Error(`claude CLI returned an error: ${parsed.result}`));
          return;
        }
        resolve(parsed.result);
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
      });
    });
  }
}
