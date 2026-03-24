import { describe, expect, it } from "vitest";

import { parsePullRequestUrl } from "../src/github-client.js";

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
