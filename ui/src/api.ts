import type { ChatMessage, DraftComment, DraftPayload, FileResponse, SessionOverviewResponse } from "./types";

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(typeof payload.error === "string" ? payload.error : response.statusText);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function createSession(prUrl: string): Promise<string> {
  const response = await request<{ sessionId: string }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ prUrl })
  });
  return response.sessionId;
}

export function loadSession(sessionId: string): Promise<SessionOverviewResponse> {
  return request<SessionOverviewResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function loadFile(sessionId: string, filePath: string): Promise<FileResponse> {
  return request<FileResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(filePath)}`
  );
}

export function saveDraft(sessionId: string, payload: DraftPayload): Promise<DraftComment> {
  return request<DraftComment>(`/api/sessions/${encodeURIComponent(sessionId)}/drafts`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function deleteDraft(sessionId: string, draftId: string): Promise<void> {
  return request<void>(
    `/api/sessions/${encodeURIComponent(sessionId)}/drafts/${encodeURIComponent(draftId)}`,
    { method: "DELETE" }
  );
}

export function persistReviewSummary(sessionId: string, reviewSummary: string): Promise<void> {
  return request<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ reviewSummary })
  });
}

export function submitReview(
  sessionId: string,
  body: string,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" = "COMMENT"
): Promise<{ url: string }> {
  return request<{ url: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/reviews`, {
    method: "POST",
    body: JSON.stringify({ body, event })
  });
}

export function runAiReview(
  sessionId: string
): Promise<{ analysis: string; draftCount: number }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/ai-review`, {
    method: "POST"
  });
}

export function sendChatMessage(
  sessionId: string,
  message: string
): Promise<{ reply: string }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: "POST",
    body: JSON.stringify({ message })
  });
}

// Re-export ChatMessage so app.tsx can import from one place
export type { ChatMessage };
