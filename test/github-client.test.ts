import { describe, expect, it, vi } from "vitest";

import { GitHubClient, parsePullRequestUrl } from "../src/clients/github-client.js";

describe("parsePullRequestUrl", () => {
  it("parses github.com URLs", () => {
    const pr = parsePullRequestUrl("https://github.com/openai/codex/pull/123");
    expect(pr.owner).toBe("openai");
    expect(pr.repo).toBe("codex");
    expect(pr.number).toBe(123);
    expect(pr.apiBaseUrl).toBe("https://api.github.com");
  });

  it("parses GHE URLs", () => {
    const pr = parsePullRequestUrl("https://ghe.example.com/team/service/pull/45/files");
    expect(pr.host).toBe("ghe.example.com");
    expect(pr.apiBaseUrl).toBe("https://ghe.example.com/api/v3");
  });

  it("rejects invalid URLs", () => {
    expect(() => parsePullRequestUrl("https://github.com/openai/codex/issues/123")).toThrow(
      "Unsupported pull request URL"
    );
  });
});

describe("GitHubClient.createReview", () => {
  it("sends multiline review comments with GitHub range fields", async () => {
    const client = new GitHubClient("token");
    const createReview = vi.fn().mockResolvedValue({
      data: { html_url: "https://github.com/openai/codex/pull/123#pullrequestreview-1" }
    });
    (client as unknown as { octokit: { pulls: { createReview: typeof createReview } } }).octokit = {
      pulls: { createReview }
    };

    const url = await client.createReview(
      parsePullRequestUrl("https://github.com/openai/codex/pull/123"),
      "abcdef",
      "review body",
      [
        {
          path: "src/app.ts",
          line: 18,
          side: "RIGHT",
          startLine: 14,
          startSide: "RIGHT",
          body: "range comment"
        }
      ]
    );

    expect(url).toContain("pullrequestreview");
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        commit_id: "abcdef",
        comments: [
          {
            path: "src/app.ts",
            line: 18,
            side: "RIGHT",
            start_line: 14,
            start_side: "RIGHT",
            body: "range comment"
          }
        ]
      })
    );
  });
});
