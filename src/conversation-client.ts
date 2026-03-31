import Anthropic from "@anthropic-ai/sdk";
import type { ConversationMessage } from "./types.js";
import { ClaudeCliClient } from "./claude-cli-client.js";
import { CodexCliClient } from "./codex-cli-client.js";

export interface ConversationClient {
  send(system: string, messages: ConversationMessage[], maxTokens?: number, signal?: AbortSignal): Promise<string>;
}

export type ClientBackend = "foundry" | "claude-cli" | "codex-cli";

export function makeConversationClient(opts: {
  backend?: ClientBackend;
  azureFoundryBaseUrl?: string;
  azureFoundryApiKey?: string;
  deploymentName?: string;
  claudeCliModel?: string;
  codexCliModel?: string;
}): ConversationClient {
  if (opts.backend === "foundry") {
    return new FoundryConversationClient(
      opts.azureFoundryBaseUrl!,
      opts.azureFoundryApiKey!,
      opts.deploymentName!
    );
  }
  if (opts.backend === "codex-cli") {
    return new CodexCliClient(opts.codexCliModel);
  }
  return new ClaudeCliClient(opts.claudeCliModel);
}

function toSdkBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "");
}

export class FoundryConversationClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(baseUrl: string, apiKey: string, deploymentName: string) {
    this.client = new Anthropic({
      apiKey,
      baseURL: toSdkBaseUrl(baseUrl)
    });
    this.model = deploymentName;
  }

  async send(
    system: string,
    messages: ConversationMessage[],
    maxTokens = 2048,
    signal?: AbortSignal
  ): Promise<string> {
    const response = await this.client.messages.create(
      { model: this.model, max_tokens: maxTokens, system, messages },
      signal ? { signal } : undefined
    );

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
}
