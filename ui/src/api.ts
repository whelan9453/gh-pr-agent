import type { AiReviewAnnotation, ChatMessage, DraftComment, DraftPayload, FileResponse, SessionOverviewResponse } from "./api-types";

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
  sessionId: string,
  onProgress: (message: string) => void,
  signal?: AbortSignal
): Promise<{ analysis: string; draftCount: number; comments: AiReviewAnnotation[] }> {
  return new Promise((resolve, reject) => {
    void (async () => {
      let response: Response;
      try {
        response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/ai-review`,
          signal ? { method: "POST", signal } : { method: "POST" }
        );
      } catch (err) {
        reject(err instanceof Error ? err : new Error("Network error"));
        return;
      }

      if (!response.ok || !response.body) {
        reject(new Error(`AI review failed: ${response.statusText}`));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            if (!part.trim()) continue;
            let eventType = "message";
            let data = "";
            for (const line of part.split("\n")) {
              if (line.startsWith("event: ")) eventType = line.slice(7).trim();
              else if (line.startsWith("data: ")) data = line.slice(6);
            }
            if (!data) continue;
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              if (eventType === "progress" && typeof parsed["message"] === "string") {
                onProgress(parsed["message"]);
              } else if (eventType === "result") {
                resolve(parsed as { analysis: string; draftCount: number; comments: AiReviewAnnotation[] });
                return;
              } else if (eventType === "error") {
                reject(new Error(typeof parsed["error"] === "string" ? parsed["error"] : "AI review error"));
                return;
              }
            } catch {
              // ignore malformed event
            }
          }
        }
        reject(new Error("AI review stream ended without result"));
      } catch (err) {
        reject(err instanceof Error ? err : new Error("Stream read error"));
      }
    })();
  });
}

export function sendAnnotationChat(
  sessionId: string,
  context: string,
  body: string,
  path: string | null,
  thread: Array<{ role: "user" | "assistant"; content: string }>,
  message: string
): Promise<{ reply: string }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/annotation-chat`, {
    method: "POST",
    body: JSON.stringify({ context, body, path, thread, message })
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

export type BackendSettings = {
  backend: "claude-cli" | "codex-cli" | "opencode-cli" | "foundry";
  claudeCliModel: string;
  codexCliModel: string;
  opencodeCliModel: string;
};

export function getSettings(): Promise<BackendSettings> {
  return request("/api/settings");
}

export function updateSettings(settings: Partial<BackendSettings>): Promise<BackendSettings> {
  return request("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(settings)
  });
}

// Re-export types so app.tsx can import from one place
export type { AiReviewAnnotation, ChatMessage };
