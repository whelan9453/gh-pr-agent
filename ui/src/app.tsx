import {
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
  saveDraft,
  submitReview
} from "./api";
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
  reviewBody: string;
  successMessage: string | null;
  onSelectPath: (path: string) => void;
  onReviewBodyChange: (value: string) => void;
  onSaveDraft: (payload: DraftPayload) => Promise<void>;
  onDeleteDraft: (draftId: string) => Promise<void>;
  onSubmitReview: (body: string) => Promise<void>;
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
          reviewBody={reviewBody}
          successMessage={successMessage}
          onSelectPath={setSelectedPath}
          onReviewBodyChange={setReviewBody}
          onSaveDraft={handleSaveDraft}
          onDeleteDraft={handleDeleteDraft}
          onSubmitReview={handleSubmitReview}
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

  const file = props.fileData?.file ?? null;
  const drafts = props.fileData?.drafts ?? [];
  const selectionSummary = file && selection ? describeSelection(file, selection) : null;

  const commentsByRow = useMemo(() => buildCommentIndex(file), [file]);

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

  return (
    <section className="workspace">
      <aside className="sidebar">
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
                    <span>{fileSummary.draftCount} drafts</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

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
                file.diffRows.map((row) => {
                  if (row.type === "hunk") {
                    return (
                      <div className="diff-hunk" key={row.key}>
                        {row.header}
                      </div>
                    );
                  }

                  const leftSelected = selection ? rowIsSelected(file, row, "LEFT", selection) : false;
                  const rightSelected = selection ? rowIsSelected(file, row, "RIGHT", selection) : false;
                  const leftComments = commentsByRow.get(`LEFT:${row.key}`) ?? [];
                  const rightComments = commentsByRow.get(`RIGHT:${row.key}`) ?? [];

                  return (
                    <div className="diff-row" key={row.key}>
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
                  );
                })
              )}
            </div>
          </>
        ) : null}
      </section>

      <aside className="review-panel">
        <div className="sidebar-card">
          <p className="eyebrow">Selection</p>
          {selectionSummary ? (
            <>
              <h3>{selectionSummary.label}</h3>
              <p className="meta-line">{selectionSummary.path}</p>
            </>
          ) : (
            <p className="meta-line">在 diff 右側或左側選一段連續行數。</p>
          )}
          <textarea
            value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            placeholder="這段改動有什麼問題？"
            rows={6}
          />
          <button
            type="button"
            disabled={!selectionSummary || !draftBody.trim() || props.savingDraft}
            onClick={() => {
              if (!selectionSummary) {
                return;
              }
              void props.onSaveDraft({
                path: selectionSummary.path,
                body: draftBody,
                side: selectionSummary.side,
                startRowKey: selectionSummary.startRowKey,
                endRowKey: selectionSummary.endRowKey
              });
              setDraftBody("");
            }}
          >
            {props.savingDraft ? "儲存中..." : "新增 Draft"}
          </button>
        </div>

        <div className="sidebar-card">
          <div className="sidebar-title-row">
            <h3>Drafts</h3>
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
