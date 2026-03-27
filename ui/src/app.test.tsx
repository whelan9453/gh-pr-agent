// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewWorkspace } from "./app";
import type { FileResponse, SessionOverviewResponse } from "./types";

function makeSession(): SessionOverviewResponse {
  return {
    session: {
      id: "session-1",
      mode: "ui-review",
      prRef: {
        owner: "openai",
        repo: "codex",
        number: 123,
        url: "https://github.com/openai/codex/pull/123"
      },
      prTitle: "UI review",
      snapshotSha: "deadbeef",
      createdAt: "2026-03-27T00:00:00.000Z",
      updatedAt: "2026-03-27T00:00:00.000Z"
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
    drafts: [],
    files: [
      {
        path: "src/app.ts",
        previousPath: null,
        status: "modified",
        additions: 3,
        deletions: 1,
        draftCount: 0,
        existingCommentCount: 0
      }
    ]
  };
}

function makeFileResponse(): FileResponse {
  return {
    file: {
      path: "src/app.ts",
      previousPath: null,
      status: "modified",
      additions: 3,
      deletions: 1,
      baseRef: "abc1234",
      headRef: "def5678",
      patch: "@@ -9,1 +9,2 @@",
      numberedPatch: "@@ -9,1 +9,2 @@",
      baseContent: "old",
      headContent: "new",
      existingComments: [],
      diffRows: [
        {
          key: "h0-header",
          hunkIndex: 0,
          type: "hunk",
          header: "@@ -9,1 +9,2 @@",
          oldLine: null,
          newLine: null,
          leftText: "@@ -9,1 +9,2 @@",
          rightText: "@@ -9,1 +9,2 @@",
          leftSelectable: false,
          rightSelectable: false
        },
        {
          key: "h0-r0",
          hunkIndex: 0,
          type: "context",
          header: null,
          oldLine: 9,
          newLine: 9,
          leftText: "const a = 1;",
          rightText: "const a = 1;",
          leftSelectable: true,
          rightSelectable: true
        },
        {
          key: "h0-r1",
          hunkIndex: 0,
          type: "add",
          header: null,
          oldLine: null,
          newLine: 10,
          leftText: "",
          rightText: "const b = 2;",
          leftSelectable: false,
          rightSelectable: true
        }
      ]
    },
    drafts: []
  };
}

describe("ReviewWorkspace", () => {
  it("creates a draft from a selected diff range", async () => {
    const user = userEvent.setup();
    const onSaveDraft = vi.fn().mockResolvedValue(undefined);

    render(
      <ReviewWorkspace
        session={makeSession()}
        fileData={makeFileResponse()}
        selectedPath="src/app.ts"
        loadingFile={false}
        savingDraft={false}
        submittingReview={false}
        reviewBody=""
        successMessage={null}
        onSelectPath={vi.fn()}
        onReviewBodyChange={vi.fn()}
        onSaveDraft={onSaveDraft}
        onDeleteDraft={vi.fn().mockResolvedValue(undefined)}
        onSubmitReview={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: "RIGHT line 9" }));
    await user.type(screen.getByPlaceholderText("這段改動有什麼問題？"), "Need another guard");
    await user.click(screen.getByRole("button", { name: "新增 Draft" }));

    expect(onSaveDraft).toHaveBeenCalledWith({
      path: "src/app.ts",
      body: "Need another guard",
      side: "RIGHT",
      startRowKey: "h0-r0",
      endRowKey: "h0-r0"
    });
  });
});
