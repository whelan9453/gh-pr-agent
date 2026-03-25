import fetch from "node-fetch";
import { z } from "zod";

import { FileReviewDraft, ReviewPayload } from "./types.js";

const IssueSchema = z
  .object({
    title: z.string(),
    severity: z.enum(["high", "medium", "low"]),
    line: z.number().int().positive().nullable(),
    confidence: z.enum(["high", "medium", "low"]),
    details: z.string()
  })
  .strict();

const FileReviewDraftSchema = z
  .object({
    summary: z.array(z.string()),
    issues: z.array(IssueSchema)
  })
  .strict();

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string; type?: string };
}

export interface ModelClient {
  reviewFile(payload: ReviewPayload): Promise<FileReviewDraft>;
}

interface ClaudeFoundryClientOptions {
  onVerbose?: (message: string) => void;
}

export function buildMessagesUrl(baseURL: string): string {
  const normalized = baseURL.replace(/\/+$/, "");

  if (normalized.endsWith("/v1/messages")) {
    return normalized;
  }

  if (normalized.endsWith("/v1")) {
    return `${normalized}/messages`;
  }

  return `${normalized}/v1/messages`;
}

function extractTextContent(responseBody: MessagesResponse): string {
  if (!Array.isArray(responseBody.content)) {
    return "";
  }

  return responseBody.content
    .flatMap((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return [block.text];
      }
      return [];
    })
    .join("")
    .trim();
}

function normalizeJsonText(text: string): string {
  const trimmed = text.trim();

  if (trimmed.startsWith("```")) {
    const withoutFenceStart = trimmed.replace(/^```(?:json)?\s*/i, "");
    const withoutFenceEnd = withoutFenceStart.replace(/\s*```$/, "");
    return withoutFenceEnd.trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

export class ClaudeFoundryClient implements ModelClient {
  private readonly apiKey: string;
  private readonly messagesUrl: string;
  private readonly deploymentName: string;
  private readonly timeoutMs: number;
  private readonly onVerbose: ((message: string) => void) | undefined;

  constructor(
    baseURL: string,
    apiKey: string,
    deploymentName: string,
    options: ClaudeFoundryClientOptions = {}
  ) {
    this.apiKey = apiKey;
    this.messagesUrl = buildMessagesUrl(baseURL);
    this.deploymentName = deploymentName;
    this.timeoutMs = 30000;
    this.onVerbose = options.onVerbose;
  }

  async reviewFile(payload: ReviewPayload): Promise<FileReviewDraft> {
    const text = normalizeJsonText(await this.runPrompt(payload));

    try {
      return FileReviewDraftSchema.parse(JSON.parse(text));
    } catch {
      this.onVerbose?.("Model returned invalid JSON on first attempt; retrying with repair prompt.");
      const repairedText = await this.runPrompt({
        prompt: `${payload.prompt}\n\nYour previous answer was not valid JSON for the requested schema. Return corrected JSON only.`,
        input: payload.input
      });
      return FileReviewDraftSchema.parse(JSON.parse(normalizeJsonText(repairedText)));
    }
  }

  private async runPrompt(payload: ReviewPayload): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const response = await fetch(this.messagesUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.deploymentName,
        max_tokens: 800,
        messages: [
          {
            role: "user",
            content: `${payload.prompt}\n\nReturn JSON only.\n\n${payload.input}`
          }
        ]
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    const responseText = await response.text();
    let parsed: MessagesResponse | undefined;
    try {
      parsed = JSON.parse(responseText) as MessagesResponse;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const errorMessage = parsed?.error?.message ?? responseText;
      throw new Error(`${response.status} ${errorMessage}`);
    }

    if (!parsed) {
      throw new Error("Model returned a non-JSON response.");
    }

    const text = extractTextContent(parsed);
    if (!text) {
      throw new Error("Model returned no text content.");
    }

    return text;
  }
}
