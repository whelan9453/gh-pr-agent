import { describe, expect, it } from "vitest";

import { GitHubClient, parsePullRequestUrl } from "../src/github-client.js";
import { ModelClient } from "../src/model-client.js";
import { ReviewEngine } from "../src/review-engine.js";
import { ChangedFile, FileReviewDraft, PullRequestInfo } from "../src/types.js";

class FakeGitHubClient {
  constructor(
    private readonly prInfo: PullRequestInfo,
    private readonly files: ChangedFile[],
    private readonly fileContent: string | null = null
  ) {}

  async getPullRequest(): Promise<PullRequestInfo> {
    return this.prInfo;
  }

  async listPullRequestFiles(): Promise<ChangedFile[]> {
    return this.files;
  }

  async getFileContent(): Promise<string | null> {
    return this.fileContent;
  }
}

class FakeModelClient implements ModelClient {
  constructor(private readonly draft: FileReviewDraft) {}

  async reviewFile(): Promise<FileReviewDraft> {
    return this.draft;
  }
}

describe("ReviewEngine", () => {
  it("nulls out invalid model line numbers", async () => {
    const pr = parsePullRequestUrl("https://github.com/openai/codex/pull/1");
    const prInfo: PullRequestInfo = {
      title: "Test",
      body: "",
      state: "open",
      author: "alice",
      base: "main",
      head: "feature",
      headSha: "abc",
      additions: 1,
      deletions: 0,
      changedFiles: 1
    };
    const files: ChangedFile[] = [
      {
        path: "src/file.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: `@@ -1,1 +1,2 @@
 keep
+new`,
        contentsUrl: "https://example.com",
        blobUrl: null
      }
    ];

    const engine = new ReviewEngine(
      new FakeGitHubClient(prInfo, files, "keep\nnew") as unknown as GitHubClient,
      new FakeModelClient({
        summary: ["something changed"],
        issues: [
          {
            title: "Invalid line",
            severity: "medium",
            line: 999,
            confidence: "low",
            details: "bad line"
          }
        ]
      }),
      "prompt"
    );

    const report = await engine.reviewPullRequest(pr);
    expect(report.files[0]?.issues[0]?.line).toBeNull();
  });
});
