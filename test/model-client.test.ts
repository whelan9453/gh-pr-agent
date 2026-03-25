import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildMessagesUrl } from "../src/model-client.js";

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

describe("review draft schema", () => {
  it("rejects extra fields", () => {
    expect(() =>
      FileReviewDraftSchema.parse({
        summary: ["ok"],
        issues: [],
        extra: true
      })
    ).toThrow();
  });
});

describe("buildMessagesUrl", () => {
  it("appends the messages path when given an anthropic base URL", () => {
    expect(buildMessagesUrl("https://example.services.ai.azure.com/anthropic")).toBe(
      "https://example.services.ai.azure.com/anthropic/v1/messages"
    );
  });

  it("accepts an already-complete messages endpoint", () => {
    expect(buildMessagesUrl("https://example.services.ai.azure.com/anthropic/v1/messages")).toBe(
      "https://example.services.ai.azure.com/anthropic/v1/messages"
    );
  });

  it("accepts a v1 endpoint and appends only messages", () => {
    expect(buildMessagesUrl("https://example.services.ai.azure.com/anthropic/v1")).toBe(
      "https://example.services.ai.azure.com/anthropic/v1/messages"
    );
  });
});
