import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createUiApp, type UiServerService } from "../src/ui-server.js";
import type { SessionOverview } from "../src/review-session.js";
import type { DraftComment, FileMaterial } from "../src/types.js";

function makeStaticDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gh-pr-ui-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body>ok</body></html>", "utf8");
  return dir;
}

function makeDraft(): DraftComment {
  return {
    id: "draft-1",
    path: "src/app.ts",
    body: "comment",
    side: "RIGHT",
    line: 12,
    startLine: 10,
    startSide: "RIGHT",
    startRowKey: "h0-r1",
    endRowKey: "h0-r3",
    hunkIndex: 0,
    createdAt: "2026-03-27T00:00:00.000Z",
    updatedAt: "2026-03-27T00:00:00.000Z"
  };
}

function makeFile(): FileMaterial {
  return {
    path: "src/app.ts",
    previousPath: null,
    status: "modified",
    additions: 3,
    deletions: 1,
    baseRef: "abc1234",
    headRef: "def5678",
    patch: "@@ -1 +1 @@",
    numberedPatch: "@@ -1 +1 @@",
    baseContent: "old",
    headContent: "new",
    diffRows: [
      {
        key: "h0-header",
        hunkIndex: 0,
        type: "hunk",
        header: "@@ -1 +1 @@",
        oldLine: null,
        newLine: null,
        leftText: "@@ -1 +1 @@",
        rightText: "@@ -1 +1 @@",
        leftSelectable: false,
        rightSelectable: false
      }
    ],
    existingComments: []
  };
}

function makeOverview(): SessionOverview {
  return {
    session: {
      id: "session-1",
      mode: "ui-review",
      prRef: {
        host: "github.com",
        owner: "openai",
        repo: "codex",
        number: 123,
        url: "https://github.com/openai/codex/pull/123",
        apiBaseUrl: "https://api.github.com"
      },
      model: "haiku",
      prTitle: "UI review",
      snapshotSha: "def5678",
      createdAt: "2026-03-27T00:00:00.000Z",
      updatedAt: "2026-03-27T00:00:00.000Z",
      cursor: {
        mode: "walkthrough",
        fileIndex: 0,
        walkthroughOrder: ["src/app.ts"]
      },
      messages: []
    },
    prInfo: {
      title: "UI review",
      body: "",
      state: "open",
      author: "w",
      base: "main",
      baseSha: "abc1234",
      head: "feature",
      headSha: "def5678",
      additions: 3,
      deletions: 1,
      changedFiles: 1
    },
    prContext: {
      description: "",
      issueComments: [],
      reviews: [],
      reviewComments: []
    },
    reviewSummary: "",
    chatMessages: [],
    drafts: [makeDraft()],
    files: [
      {
        path: "src/app.ts",
        previousPath: null,
        status: "modified",
        additions: 3,
        deletions: 1,
        draftCount: 1,
        existingCommentCount: 0
      }
    ]
  };
}

describe("createUiApp", () => {
  it("creates drafts and returns session data through the API", async () => {
    const service: UiServerService = {
      createSession: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
      getSessionOverview: vi.fn().mockReturnValue(makeOverview()),
      getFile: vi.fn().mockReturnValue({ file: makeFile(), drafts: [makeDraft()] }),
      saveDraft: vi.fn().mockReturnValue(makeDraft()),
      deleteDraft: vi.fn(),
      setReviewSummary: vi.fn(),
      submitReview: vi.fn().mockResolvedValue({ url: "https://github.com/review/1", drafts: [] }),
      runAiReview: vi.fn().mockResolvedValue({ analysis: "LGTM", draftCount: 0, comments: [] }),
      sendAnnotationChat: vi.fn().mockResolvedValue({ reply: "ok" }),
      sendChatMessage: vi.fn().mockResolvedValue({ reply: "ok" })
    };
    const app = createUiApp({ service, staticDir: makeStaticDir() });

    const createResponse = await request(app)
      .post("/api/sessions")
      .send({ prUrl: "https://github.com/openai/codex/pull/123" });
    expect(createResponse.status).toBe(201);
    expect(createResponse.body).toEqual({ sessionId: "session-1" });

    const draftResponse = await request(app)
      .post("/api/sessions/session-1/drafts")
      .send({
        path: "src/app.ts",
        body: "comment",
        side: "RIGHT",
        startRowKey: "h0-r1",
        endRowKey: "h0-r3"
      });

    expect(draftResponse.status).toBe(201);
    expect(service.saveDraft).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        path: "src/app.ts",
        side: "RIGHT"
      })
    );

    const fileResponse = await request(app).get("/api/sessions/session-1/files/src%2Fapp.ts");
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.body.file.path).toBe("src/app.ts");
  });
});
