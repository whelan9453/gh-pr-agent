import { marked } from "marked";
import React, {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { JSX } from "react";
import {
  createSession,
  deleteDraft,
  loadFile,
  loadSession,
  persistReviewSummary,
  runAiReview,
  saveDraft,
  sendChatMessage,
  submitReview
} from "./api";
import type { AiReviewAnnotation, ChatMessage } from "./api";
import type {
  DiffRow,
  DraftPayload,
  ExistingInlineComment,
  FileMaterial,
  FileResponse,
  FileSummary,
  ReviewCommentSide,
  SessionOverviewResponse
} from "./types";

interface SelectionState {
  side: ReviewCommentSide;
  startRowKey: string;
  endRowKey: string;
}

interface ReviewWorkspaceProps {
  session: SessionOverviewResponse;
  fileData: FileResponse | null;
  selectedPath: string | null;
  loadingFile: boolean;
  savingDraft: boolean;
  submittingReview: boolean;
  runningAiReview: boolean;
  sendingChat: boolean;
  reviewBody: string;
  chatMessages: ChatMessage[];
  successMessage: string | null;
  onSelectPath: (path: string) => void;
  onReviewBodyChange: (value: string) => void;
  onSaveDraft: (payload: DraftPayload) => Promise<void>;
  onDeleteDraft: (draftId: string) => Promise<void>;
  onSubmitReview: (body: string) => Promise<void>;
  onRunAiReview: () => Promise<void>;
  onSendChatMessage: (message: string) => Promise<void>;
}

export default function App(): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionOverviewResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const deferredSelectedPath = useDeferredValue(selectedPath);
  const [fileData, setFileData] = useState<FileResponse | null>(null);
  const [createInput, setCreateInput] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [runningAiReview, setRunningAiReview] = useState(false);
  const [sendingChat, setSendingChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) {
      return;
    }
    bootstrapped.current = true;

    const params = new URLSearchParams(window.location.search);
    const existingSession = params.get("session");
    const prUrl = params.get("prUrl");

    if (existingSession) {
      void refreshSession(existingSession, true);
      return;
    }
    if (prUrl) {
      setCreateInput(prUrl);
      void handleCreateSession(prUrl);
    }
  }, []);

  useEffect(() => {
    if (!sessionId || !deferredSelectedPath) {
      return;
    }
    void refreshFile(sessionId, deferredSelectedPath);
  }, [deferredSelectedPath, sessionId]);

  useEffect(() => {
    if (!sessionId || !session) {
      return;
    }
    if (reviewBody === session.reviewSummary) {
      return;
    }

    const timer = window.setTimeout(() => {
      void persistReviewSummary(sessionId, reviewBody).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unable to save review summary.";
        setError(message);
      });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [reviewBody, session, sessionId]);

  async function handleCreateSession(prUrl: string): Promise<void> {
    try {
      setCreatingSession(true);
      setError(null);
      const nextSessionId = await createSession(prUrl);
      window.history.replaceState({}, "", `/?session=${encodeURIComponent(nextSessionId)}`);
      setSessionId(nextSessionId);
      await refreshSession(nextSessionId, true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to create review session.");
    } finally {
      setCreatingSession(false);
    }
  }

  async function refreshSession(nextSessionId: string, resetSelection = false): Promise<void> {
    try {
      setLoadingSession(true);
      setError(null);
      const payload = await loadSession(nextSessionId);
      startTransition(() => {
        setSessionId(nextSessionId);
        setSession(payload);
        setReviewBody(payload.reviewSummary);
        setChatMessages(payload.chatMessages ?? []);
        setSelectedPath((current) => {
          if (current && payload.files.some((file) => file.path === current) && !resetSelection) {
            return current;
          }
          return payload.files[0]?.path ?? null;
        });
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to load review session.");
    } finally {
      setLoadingSession(false);
    }
  }

  async function refreshFile(nextSessionId: string, filePath: string): Promise<void> {
    try {
      setLoadingFile(true);
      setError(null);
      const payload = await loadFile(nextSessionId, filePath);
      startTransition(() => setFileData(payload));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to load file diff.");
    } finally {
      setLoadingFile(false);
    }
  }

  async function handleSaveDraft(payload: DraftPayload): Promise<void> {
    if (!sessionId || !selectedPath) {
      return;
    }
    try {
      setSavingDraft(true);
      setError(null);
      await saveDraft(sessionId, payload);
      await Promise.all([refreshSession(sessionId), refreshFile(sessionId, selectedPath)]);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save draft comment.");
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleDeleteDraft(draftId: string): Promise<void> {
    if (!sessionId || !selectedPath) {
      return;
    }
    try {
      setSavingDraft(true);
      setError(null);
      await deleteDraft(sessionId, draftId);
      await Promise.all([refreshSession(sessionId), refreshFile(sessionId, selectedPath)]);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to delete draft comment.");
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleRunAiReview(): Promise<void> {
    if (!sessionId) return;
    try {
      setRunningAiReview(true);
      setError(null);
      const result = await runAiReview(sessionId);
      await refreshSession(sessionId);
      // refreshSession overwrites chatMessages from server (no annotations), so re-attach them now
      setChatMessages((prev) => {
        const lastIdx = prev.length - 1;
        if (lastIdx < 0 || prev[lastIdx]?.role !== "assistant") return prev;
        return prev.map((m, i) => i === lastIdx ? { ...m, annotations: result.comments } : m);
      });
      if (selectedPath) await refreshFile(sessionId, selectedPath);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to run AI review.");
    } finally {
      setRunningAiReview(false);
    }
  }

  async function handleSendChatMessage(message: string): Promise<void> {
    if (!sessionId) return;
    try {
      setSendingChat(true);
      setError(null);
      setChatMessages((prev) => [...prev, { role: "user", content: message }]);
      const result = await sendChatMessage(sessionId, message);
      setChatMessages((prev) => [...prev, { role: "assistant", content: result.reply }]);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to send message.");
    } finally {
      setSendingChat(false);
    }
  }

  async function handleSubmitReview(body: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    try {
      setSubmittingReview(true);
      setError(null);
      const result = await submitReview(sessionId, body);
      setSuccessMessage(`Review posted: ${result.url}`);
      await refreshSession(sessionId);
      if (selectedPath) {
        await refreshFile(sessionId, selectedPath);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to submit review.");
    } finally {
      setSubmittingReview(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <span className="hero-title">PR Review</span>
        <form
          className="launch-card"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreateSession(createInput.trim());
          }}
        >
          <label htmlFor="pr-url">PR URL</label>
          <input
            id="pr-url"
            name="pr-url"
            type="text"
            autoComplete="off"
            placeholder="https://github.com/OWNER/REPO/pull/123"
            value={createInput}
            onChange={(event) => setCreateInput(event.target.value)}
          />
          <button type="submit" disabled={creatingSession || !createInput.trim()}>
            {creatingSession ? "Loading…" : "Open"}
          </button>
        </form>
      </header>

      {error ? <section className="banner error">{error}</section> : null}
      {successMessage ? <section className="banner success">{successMessage}</section> : null}

      {loadingSession ? <section className="empty-panel">正在載入 session...</section> : null}

      {session ? (
        <ReviewWorkspace
          session={session}
          fileData={fileData}
          selectedPath={selectedPath}
          loadingFile={loadingFile}
          savingDraft={savingDraft}
          submittingReview={submittingReview}
          runningAiReview={runningAiReview}
          sendingChat={sendingChat}
          chatMessages={chatMessages}
          reviewBody={reviewBody}
          successMessage={successMessage}
          onSelectPath={setSelectedPath}
          onReviewBodyChange={setReviewBody}
          onSaveDraft={handleSaveDraft}
          onDeleteDraft={handleDeleteDraft}
          onSubmitReview={handleSubmitReview}
          onRunAiReview={handleRunAiReview}
          onSendChatMessage={handleSendChatMessage}
        />
      ) : (
        <section className="empty-panel">
          <p>輸入一個 PR URL 後，這裡會出現本地 review session。</p>
        </section>
      )}
    </main>
  );
}

export function ReviewWorkspace(props: ReviewWorkspaceProps): JSX.Element {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [anchor, setAnchor] = useState<{ rowKey: string; side: ReviewCommentSide } | null>(null);
  const [dragging, setDragging] = useState<SelectionState | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(360);
  const resizing = useRef<"left" | "right" | null>(null);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  const [draftsHeight, setDraftsHeight] = useState(160);
  const [summaryHeight, setSummaryHeight] = useState(200);
  const vResizing = useRef<"chat-drafts" | "drafts-summary" | null>(null);
  const vResizeStartY = useRef(0);
  const vResizeStartHeights = useRef<[number, number]>([0, 0]);

  const pendingScrollTarget = useRef<{ path: string; line: number } | null>(null);

  useEffect(() => {
    setSelection(null);
    setAnchor(null);
    setDragging(null);
    setDraftBody("");
  }, [props.selectedPath]);

  useEffect(() => {
    if (!dragging) {
      return;
    }
    const stop = (): void => setDragging(null);
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, [dragging]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent): void {
      if (resizing.current) {
        const delta = e.clientX - resizeStartX.current;
        if (resizing.current === "left") {
          setLeftWidth(Math.max(160, Math.min(window.innerWidth - 600, resizeStartWidth.current + delta)));
        } else {
          setRightWidth(Math.max(200, Math.min(window.innerWidth - 400, resizeStartWidth.current - delta)));
        }
      }
      if (vResizing.current) {
        const delta = e.clientY - vResizeStartY.current;
        const [a, b] = vResizeStartHeights.current;
        if (vResizing.current === "chat-drafts") {
          // chat is flex:1 so only drafts height changes
          setDraftsHeight(Math.max(60, a - delta));
        } else {
          setDraftsHeight(Math.max(60, a + delta));
          setSummaryHeight(Math.max(80, b - delta));
        }
      }
    }
    function onMouseUp(): void {
      resizing.current = null;
      vResizing.current = null;
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    const target = pendingScrollTarget.current;
    if (!target || !props.fileData || props.fileData.file.path !== target.path) return;
    const row = props.fileData.file.diffRows.find(
      (r) => r.type !== "hunk" && r.rightSelectable && r.newLine === target.line
    );
    if (row) {
      document.getElementById(`diff-row-${row.key}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    pendingScrollTarget.current = null;
  }, [props.fileData]);

  function handleAnnotationClick(annotation: AiReviewAnnotation): void {
    if (!annotation.path || annotation.line == null) return;
    const alreadyLoaded =
      props.fileData?.file.path === annotation.path;
    if (alreadyLoaded) {
      const row = props.fileData!.file.diffRows.find(
        (r) => r.type !== "hunk" && r.rightSelectable && r.newLine === annotation.line
      );
      if (row) {
        document.getElementById(`diff-row-${row.key}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } else {
      pendingScrollTarget.current = { path: annotation.path, line: annotation.line };
      props.onSelectPath(annotation.path);
    }
  }

  const file = props.fileData?.file ?? null;
  const drafts = props.fileData?.drafts ?? [];
  const selectionSummary = file && selection ? describeSelection(file, selection) : null;

  const commentsByRow = useMemo(() => buildCommentIndex(file), [file]);

  const selectionEndKey = useMemo(() => {
    if (!selection || !file) return null;
    const startIndex = file.diffRows.findIndex((r) => r.key === selection.startRowKey);
    const endIndex = file.diffRows.findIndex((r) => r.key === selection.endRowKey);
    if (startIndex < 0 || endIndex < 0) return null;
    return file.diffRows[Math.max(startIndex, endIndex)]?.key ?? null;
  }, [selection, file]);

  function handleRowPress(row: DiffRow, side: ReviewCommentSide, shiftKey: boolean): void {
    if (!isSelectable(row, side)) {
      return;
    }
    const nextAnchor = shiftKey && anchor?.side === side ? anchor : { rowKey: row.key, side };
    setAnchor(nextAnchor);
    setSelection({
      side,
      startRowKey: nextAnchor.rowKey,
      endRowKey: row.key
    });
    setDragging({
      side,
      startRowKey: nextAnchor.rowKey,
      endRowKey: row.key
    });
  }

  function handleRowHover(row: DiffRow, side: ReviewCommentSide): void {
    if (!dragging || dragging.side !== side || !isSelectable(row, side)) {
      return;
    }
    setSelection({
      side,
      startRowKey: dragging.startRowKey,
      endRowKey: row.key
    });
  }

  function startResize(side: "left" | "right", e: React.MouseEvent): void {
    resizing.current = side;
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = side === "left" ? leftWidth : rightWidth;
    e.preventDefault();
  }

  function startVResize(boundary: "chat-drafts" | "drafts-summary", e: React.MouseEvent): void {
    vResizing.current = boundary;
    vResizeStartY.current = e.clientY;
    vResizeStartHeights.current = boundary === "chat-drafts"
      ? [draftsHeight, draftsHeight]
      : [draftsHeight, summaryHeight];
    e.preventDefault();
  }

  return (
    <section className="workspace">
      <aside className="sidebar" style={{ width: leftWidth }}>
        <div className="sidebar-card">
          <p className="eyebrow">PR</p>
          <h2>{props.session.prInfo.title}</h2>
          <p className="meta-line">
            {props.session.session.prRef.owner}/{props.session.session.prRef.repo}#{props.session.session.prRef.number}
          </p>
          <p className="meta-line">
            {props.session.prInfo.base} → {props.session.prInfo.head}
          </p>
          <p className="stats">
            <span>+{props.session.prInfo.additions}</span>
            <span>-{props.session.prInfo.deletions}</span>
            <span>{props.session.prInfo.changedFiles} files</span>
          </p>
        </div>

        <div className="sidebar-card files-card">
          <div className="sidebar-title-row">
            <h3>Files</h3>
            <span>{props.session.files.length}</span>
          </div>
          <ul className="file-list">
            {props.session.files.map((fileSummary) => (
              <li key={fileSummary.path}>
                <button
                  type="button"
                  className={fileSummary.path === props.selectedPath ? "file-button active" : "file-button"}
                  onClick={() => props.onSelectPath(fileSummary.path)}
                >
                  <span className="file-main">
                    <span className="file-path">{fileSummary.path}</span>
                    <span className="file-status">{fileSummary.status}</span>
                  </span>
                  <span className="file-meta">
                    <span>+{fileSummary.additions}</span>
                    <span>-{fileSummary.deletions}</span>
                    {fileSummary.draftCount > 0 ? <span>{fileSummary.draftCount} 則留言</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <div
        className={`resize-handle${resizing.current === "left" ? " dragging" : ""}`}
        onMouseDown={(e) => startResize("left", e)}
      />
      <section className="diff-panel">
        {props.loadingFile ? <div className="diff-empty">正在載入 diff...</div> : null}
        {!props.loadingFile && file ? (
          <>
            <header className="diff-header">
              <div>
                <p className="eyebrow">Diff</p>
                <h3>{file.path}</h3>
                {file.previousPath ? <p className="meta-line">renamed from {file.previousPath}</p> : null}
              </div>
              <div className="diff-totals">
                <span>Base {file.baseRef.slice(0, 7)}</span>
                <span>Head {file.headRef.slice(0, 7)}</span>
              </div>
            </header>

            <div className="diff-table" role="table" aria-label="Split diff">
              {file.diffRows.length === 0 ? (
                <div className="diff-empty">這個檔案沒有可顯示的 textual diff。</div>
              ) : (
                file.diffRows.flatMap((row) => {
                  if (row.type === "hunk") {
                    return [
                      <div className="diff-hunk" key={row.key}>
                        {row.header}
                      </div>
                    ];
                  }

                  const leftSelected = selection ? rowIsSelected(file, row, "LEFT", selection) : false;
                  const rightSelected = selection ? rowIsSelected(file, row, "RIGHT", selection) : false;
                  const leftComments = commentsByRow.get(`LEFT:${row.key}`) ?? [];
                  const rightComments = commentsByRow.get(`RIGHT:${row.key}`) ?? [];

                  const elements: JSX.Element[] = [
                    <div className="diff-row" key={row.key} id={`diff-row-${row.key}`}>
                      <DiffCell
                        row={row}
                        side="LEFT"
                        selected={leftSelected}
                        commented={leftComments.length > 0}
                        comments={leftComments}
                        onMouseDown={(shiftKey) => handleRowPress(row, "LEFT", shiftKey)}
                        onMouseEnter={() => handleRowHover(row, "LEFT")}
                      />
                      <DiffCell
                        row={row}
                        side="RIGHT"
                        selected={rightSelected}
                        commented={rightComments.length > 0}
                        comments={rightComments}
                        onMouseDown={(shiftKey) => handleRowPress(row, "RIGHT", shiftKey)}
                        onMouseEnter={() => handleRowHover(row, "RIGHT")}
                      />
                    </div>
                  ];

                  if (!dragging && selectionSummary && row.key === selectionEndKey) {
                    elements.push(
                      <div key="inline-form" className="diff-inline-form">
                        <span className="inline-form-label">{selectionSummary.label}</span>
                        <textarea
                          value={draftBody}
                          onChange={(e) => setDraftBody(e.target.value)}
                          placeholder="這段改動有什麼問題？"
                          rows={4}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Escape") { setSelection(null); setDraftBody(""); }
                          }}
                        />
                        <div className="inline-form-actions">
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => { setSelection(null); setDraftBody(""); }}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            disabled={!draftBody.trim() || props.savingDraft}
                            onClick={() => {
                              void props.onSaveDraft({
                                path: selectionSummary.path,
                                body: draftBody,
                                side: selectionSummary.side,
                                startRowKey: selectionSummary.startRowKey,
                                endRowKey: selectionSummary.endRowKey
                              });
                              setDraftBody("");
                              setSelection(null);
                            }}
                          >
                            {props.savingDraft ? "儲存中..." : "新增留言"}
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return elements;
                })
              )}
            </div>
          </>
        ) : null}
      </section>

      <div
        className={`resize-handle${resizing.current === "right" ? " dragging" : ""}`}
        onMouseDown={(e) => startResize("right", e)}
      />
      <aside className="review-panel" style={{ width: rightWidth }}>
        <div className="sidebar-card">
          <p className="eyebrow">AI Review</p>
          <p className="meta-line">用 pr-summary 提示自動產生 draft comments。</p>
          <button
            type="button"
            disabled={props.runningAiReview}
            onClick={() => void props.onRunAiReview()}
          >
            {props.runningAiReview ? "分析中..." : "執行 AI Review"}
          </button>
        </div>

        <div className="review-section chat-section">
          <ChatPanel
            messages={props.chatMessages}
            sending={props.sendingChat}
            onSend={props.onSendChatMessage}
            onAnnotationClick={handleAnnotationClick}
          />
        </div>

        <div
          className={`v-resize-handle${vResizing.current === "chat-drafts" ? " dragging" : ""}`}
          onMouseDown={(e) => startVResize("chat-drafts", e)}
        />

        <div className="review-section" style={{ height: draftsHeight }}>
          <div className="sidebar-card">
            <div className="sidebar-title-row">
              <h3>待送出留言</h3>
              <span>{drafts.length}</span>
            </div>
            <ul className="draft-list">
              {drafts.map((draft) => (
                <li key={draft.id} className="draft-item">
                  <p className="draft-title">{formatDraftRange(draft)}</p>
                  <p>{draft.body}</p>
                  <button type="button" onClick={() => void props.onDeleteDraft(draft.id)}>
                    刪除
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div
          className={`v-resize-handle${vResizing.current === "drafts-summary" ? " dragging" : ""}`}
          onMouseDown={(e) => startVResize("drafts-summary", e)}
        />

        <div className="review-section" style={{ height: summaryHeight }}>
          <div className="sidebar-card">
            <p className="eyebrow">Review Summary</p>
            <textarea
              value={props.reviewBody}
              onChange={(event) => props.onReviewBodyChange(event.target.value)}
              placeholder="總結這次 review。可以留空，只送 inline comments。"
              rows={8}
            />
            <button
              type="button"
              disabled={props.submittingReview || (drafts.length === 0 && !props.reviewBody.trim())}
              onClick={() => setConfirmOpen(true)}
            >
              {props.submittingReview ? "送出中..." : "送出 Review"}
            </button>
          </div>
        </div>

        {confirmOpen ? (
          <section className="confirm-sheet" role="dialog" aria-modal="true">
            <div className="confirm-card">
              <p className="eyebrow">Ready to Post</p>
              <h3>{drafts.length} inline comments</h3>
              <p className="meta-line">{props.reviewBody.trim() || "No review summary"}</p>
              <ul className="draft-list compact">
                {drafts.map((draft) => (
                  <li key={draft.id}>{formatDraftRange(draft)}</li>
                ))}
              </ul>
              <div className="confirm-actions">
                <button type="button" className="ghost" onClick={() => setConfirmOpen(false)}>
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmOpen(false);
                    void props.onSubmitReview(props.reviewBody);
                  }}
                >
                  確認送出
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </aside>
    </section>
  );
}

interface ChatPanelProps {
  messages: ChatMessage[];
  sending: boolean;
  onSend: (message: string) => Promise<void>;
  onAnnotationClick: (annotation: AiReviewAnnotation) => void;
}

function ChatPanel(props: ChatPanelProps): JSX.Element {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.messages]);

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault();
    const message = input.trim();
    if (!message || props.sending) return;
    setInput("");
    void props.onSend(message);
  }

  return (
    <div className="sidebar-card chat-card">
      <p className="eyebrow">Chat</p>
      {props.messages.length === 0 ? (
        <p className="meta-line">先執行 AI Review，或直接輸入問題。</p>
      ) : (
        <div className="chat-messages">
          {props.messages.map((msg, i) => (
            <div key={i} className="chat-message-group">
              <div
                className={`chat-bubble ${msg.role}`}
                dangerouslySetInnerHTML={{ __html: marked(msg.content) as string }}
              />
              {msg.annotations && msg.annotations.length > 0 ? (
                <div className="annotation-chips">
                  {msg.annotations.filter((a) => a.path).map((a, j) => (
                    <button
                      key={j}
                      type="button"
                      className="annotation-chip"
                      onClick={() => props.onAnnotationClick(a)}
                    >
                      <span className="annotation-chip-context">{a.context}</span>
                      <span className="annotation-chip-loc">{a.path}{a.line != null ? `:${a.line}` : ""}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
      <form className="chat-form" onSubmit={handleSubmit}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="問關於這個 PR 的問題..."
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
        />
        <button type="submit" disabled={!input.trim() || props.sending}>
          {props.sending ? "傳送中..." : "傳送"}
        </button>
      </form>
    </div>
  );
}

interface DiffCellProps {
  row: DiffRow;
  side: ReviewCommentSide;
  selected: boolean;
  commented: boolean;
  comments: ExistingInlineComment[];
  onMouseDown: (shiftKey: boolean) => void;
  onMouseEnter: () => void;
}

function DiffCell(props: DiffCellProps): JSX.Element {
  const selectable = isSelectable(props.row, props.side);
  const lineNo = props.side === "LEFT" ? props.row.oldLine : props.row.newLine;
  const text = props.side === "LEFT" ? props.row.leftText : props.row.rightText;
  const cellClass = [
    "diff-cell",
    props.side === "LEFT" ? "left" : "right",
    selectable ? "selectable" : "blank",
    props.selected ? "selected" : "",
    props.commented ? "commented" : "",
    props.row.type === "add" && props.side === "RIGHT" ? "added" : "",
    props.row.type === "del" && props.side === "LEFT" ? "deleted" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={cellClass}
      disabled={!selectable}
      aria-label={`${props.side} line ${lineNo ?? "blank"}`}
      onMouseDown={(event) => props.onMouseDown(event.shiftKey)}
      onMouseEnter={props.onMouseEnter}
    >
      <span className="line-no">{lineNo ?? ""}</span>
      <code>{text || " "}</code>
      {props.comments.length > 0 ? (
        <span className="comment-stack">
          {props.comments.map((comment) => (
            <span key={comment.id} className="existing-comment">
              <strong>@{comment.author}</strong> {comment.body}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

function buildCommentIndex(file: FileMaterial | null): Map<string, ExistingInlineComment[]> {
  const index = new Map<string, ExistingInlineComment[]>();
  if (!file) {
    return index;
  }

  for (const row of file.diffRows) {
    if (row.type === "hunk") {
      continue;
    }
    for (const side of ["LEFT", "RIGHT"] as const) {
      const matches = file.existingComments.filter((comment) => commentMatchesRow(comment, row, side));
      if (matches.length > 0) {
        index.set(`${side}:${row.key}`, matches);
      }
    }
  }

  return index;
}

function describeSelection(file: FileMaterial, selection: SelectionState): {
  path: string;
  side: ReviewCommentSide;
  startRowKey: string;
  endRowKey: string;
  label: string;
} | null {
  const startIndex = file.diffRows.findIndex((row) => row.key === selection.startRowKey);
  const endIndex = file.diffRows.findIndex((row) => row.key === selection.endRowKey);
  if (startIndex < 0 || endIndex < 0) {
    return null;
  }
  const lower = Math.min(startIndex, endIndex);
  const upper = Math.max(startIndex, endIndex);
  const rows = file.diffRows.slice(lower, upper + 1).filter((row) => isSelectable(row, selection.side));
  if (rows.length === 0) {
    return null;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) {
    return null;
  }
  const firstLine = selection.side === "LEFT" ? first?.oldLine : first?.newLine;
  const lastLine = selection.side === "LEFT" ? last?.oldLine : last?.newLine;
  if (!firstLine || !lastLine) {
    return null;
  }
  return {
    path: file.path,
    side: selection.side,
    startRowKey: first.key,
    endRowKey: last.key,
    label:
      firstLine === lastLine
        ? `${selection.side} ${firstLine}`
        : `${selection.side} ${firstLine}-${lastLine}`
  };
}

function rowIsSelected(
  file: FileMaterial,
  row: DiffRow,
  side: ReviewCommentSide,
  selection: SelectionState
): boolean {
  if (side !== selection.side) {
    return false;
  }
  const startIndex = file.diffRows.findIndex((entry) => entry.key === selection.startRowKey);
  const endIndex = file.diffRows.findIndex((entry) => entry.key === selection.endRowKey);
  const rowIndex = file.diffRows.findIndex((entry) => entry.key === row.key);
  if (startIndex < 0 || endIndex < 0 || rowIndex < 0) {
    return false;
  }
  const lower = Math.min(startIndex, endIndex);
  const upper = Math.max(startIndex, endIndex);
  return rowIndex >= lower && rowIndex <= upper && isSelectable(row, side);
}

function commentMatchesRow(
  comment: ExistingInlineComment,
  row: DiffRow,
  side: ReviewCommentSide
): boolean {
  const commentSide = comment.side ?? "RIGHT";
  if (commentSide !== side) {
    return false;
  }
  const startLine = comment.startLine ?? comment.line;
  const endLine = comment.line;
  const rowLine = side === "LEFT" ? row.oldLine : row.newLine;
  if (!rowLine || !startLine || !endLine) {
    return false;
  }
  return rowLine >= Math.min(startLine, endLine) && rowLine <= Math.max(startLine, endLine);
}

function formatDraftRange(draft: { path: string; side: ReviewCommentSide; line: number; startLine: number | null }): string {
  const start = draft.startLine ?? draft.line;
  return `${draft.path} • ${draft.side} ${start === draft.line ? draft.line : `${start}-${draft.line}`}`;
}

function isSelectable(row: DiffRow, side: ReviewCommentSide): boolean {
  return side === "LEFT" ? row.leftSelectable : row.rightSelectable;
}
