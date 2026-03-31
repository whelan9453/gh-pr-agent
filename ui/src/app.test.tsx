// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewWorkspace } from "./app";
import type { AiReviewAnnotation, FileResponse, SessionOverviewResponse } from "./types";

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
    chatMessages: [],
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

function makeAnnotation(): AiReviewAnnotation {
  return {
    context: "Leave allocation API validation",
    severity: "must-fix",
    description: "`type` 未受限於合法假別，無效值目前會走到 KeyError 並回傳 500。",
    body: "建議在 schema 層就限制 `type` 只能是合法 leave type。",
    path: "src/app.ts",
    line: 10
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
        runningAiReview={false}
        aiReviewStatus=""
        backendSettings={{ backend: "claude-cli", claudeCliModel: "claude-sonnet-4-6", codexCliModel: "" }}
        onBackendSettingsChange={vi.fn()}
        sendingChat={false}
        chatMessages={[]}
        reviewBody=""
        successMessage={null}
        onSelectPath={vi.fn()}
        onReviewBodyChange={vi.fn()}
        onSaveDraft={onSaveDraft}
        onDeleteDraft={vi.fn().mockResolvedValue(undefined)}
        onSubmitReview={vi.fn().mockResolvedValue(undefined)}
        onRunAiReview={vi.fn().mockResolvedValue(undefined)}
        onSendChatMessage={vi.fn().mockResolvedValue(undefined)}
        onSendAnnotationMessage={vi.fn().mockResolvedValue("")}
        onAddAnnotationDraft={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: "RIGHT line 9" }));
    fireEvent.mouseUp(window);
    await user.type(screen.getByPlaceholderText("這段改動有什麼問題？"), "Need another guard");
    await user.click(screen.getByRole("button", { name: "新增留言" }));

    expect(onSaveDraft).toHaveBeenCalledWith({
      path: "src/app.ts",
      body: "Need another guard",
      side: "RIGHT",
      startRowKey: "h0-r0",
      endRowKey: "h0-r0"
    });
  });

  it("shows annotation chat messages immediately after send", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    let resolveReply!: (value: string) => void;
    const onSendAnnotationMessage = vi.fn().mockImplementation(() =>
      new Promise<string>((resolve) => {
        resolveReply = resolve;
      })
    );

    render(
      <ReviewWorkspace
        session={{
          ...makeSession(),
          chatMessages: [{ role: "assistant", content: "Review result", annotations: [makeAnnotation()] }]
        }}
        fileData={makeFileResponse()}
        selectedPath="src/app.ts"
        loadingFile={false}
        savingDraft={false}
        submittingReview={false}
        runningAiReview={false}
        aiReviewStatus=""
        backendSettings={{ backend: "claude-cli", claudeCliModel: "claude-sonnet-4-6", codexCliModel: "" }}
        onBackendSettingsChange={vi.fn()}
        sendingChat={false}
        chatMessages={[{ role: "assistant", content: "Review result", annotations: [makeAnnotation()] }]}
        reviewBody=""
        successMessage={null}
        onSelectPath={vi.fn()}
        onReviewBodyChange={vi.fn()}
        onSaveDraft={vi.fn().mockResolvedValue(undefined)}
        onDeleteDraft={vi.fn().mockResolvedValue(undefined)}
        onSubmitReview={vi.fn().mockResolvedValue(undefined)}
        onRunAiReview={vi.fn().mockResolvedValue(undefined)}
        onSendChatMessage={vi.fn().mockResolvedValue(undefined)}
        onSendAnnotationMessage={onSendAnnotationMessage}
        onAddAnnotationDraft={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await user.click(screen.getByRole("button", { name: "▼ 討論 / 新增留言" }));
    const annotationChatForm = screen.getByPlaceholderText("針對這個問題提問...").closest("form");
    if (!annotationChatForm) {
      throw new Error("Annotation chat form not found");
    }
    await user.type(within(annotationChatForm).getByPlaceholderText("針對這個問題提問..."), "上次給的意見都修正了嗎");
    await user.click(within(annotationChatForm).getByRole("button", { name: "傳送" }));

    expect(screen.getByText("上次給的意見都修正了嗎")).toBeTruthy();
    expect(onSendAnnotationMessage).toHaveBeenCalledWith(
      "Leave allocation API validation",
      "建議在 schema 層就限制 `type` 只能是合法 leave type。",
      "src/app.ts",
      [],
      "上次給的意見都修正了嗎"
    );

    resolveReply("看起來大致修正了，但還要補 enum 驗證。");
    expect(await screen.findByText("看起來大致修正了，但還要補 enum 驗證。")).toBeTruthy();
  });
});
