import { describe, expect, it } from "vitest";
import { z } from "zod";

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
