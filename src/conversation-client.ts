import Anthropic from "@anthropic-ai/sdk";
import type { ConversationMessage } from "./types.js";

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
    maxTokens = 2048
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages
    });

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
}
