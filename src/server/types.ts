import type { ClientBackend } from "../clients/conversation-client.js";
import type { AppConfig, DraftComment, FileMaterial, ReviewSubmissionPayload } from "../types.js";
import type { DraftCommentInput, SessionOverview } from "../services/session.js";

export interface BackendSettings {
  backend: ClientBackend;
  claudeCliModel: string;
  codexCliModel: string;
}

export interface UiServerService {
  createSession(prUrl: string): Promise<{ sessionId: string }>;
  getSessionOverview(sessionId: string): SessionOverview;
  getFile(sessionId: string, filePath: string): { file: FileMaterial; drafts: DraftComment[] };
  saveDraft(sessionId: string, input: DraftCommentInput): DraftComment;
  deleteDraft(sessionId: string, draftId: string): void;
  setReviewSummary(sessionId: string, reviewSummary: string): void;
  submitReview(
    sessionId: string,
    payload: ReviewSubmissionPayload
  ): Promise<{ url: string; drafts: DraftComment[] }>;
  runAiReview(sessionId: string, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<{ analysis: string; draftCount: number; comments: Array<{ context: string; severity: "must-fix" | "should-fix"; description: string; body: string; path: string | null; line: number | null; alreadyTracked?: boolean }> }>;
  sendAnnotationChat(sessionId: string, context: string, body: string, path: string | null, thread: Array<{ role: "user" | "assistant"; content: string }>, message: string): Promise<{ reply: string }>;
  sendChatMessage(sessionId: string, message: string): Promise<{ reply: string }>;
  getSettings(): BackendSettings;
  updateSettings(settings: Partial<BackendSettings>): void;
}

export interface CreateUiServerOptions {
  service: UiServerService;
  staticDir?: string;
}

export interface StartUiServerOptions {
  config: AppConfig;
  initialPrUrl?: string;
}
