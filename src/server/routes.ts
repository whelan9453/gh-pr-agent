import { type Express, type Request, type Response } from "express";
import { z } from "zod";
import type { ReviewSubmissionPayload } from "../types.js";
import type { BackendSettings, UiServerService } from "./types.js";

const createSessionSchema = z.object({
  prUrl: z.string().url()
});

const updateDraftSchema = z.object({
  id: z.string().optional(),
  path: z.string().min(1),
  body: z.string().min(1),
  side: z.enum(["LEFT", "RIGHT"]),
  startRowKey: z.string().min(1),
  endRowKey: z.string().min(1)
});

const reviewSummarySchema = z.object({
  reviewSummary: z.string()
});

const submitReviewSchema = z.object({
  body: z.string(),
  event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).optional()
});

const annotationChatSchema = z.object({
  context: z.string().min(1),
  body: z.string(),
  path: z.string().nullable(),
  thread: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
  message: z.string().min(1)
});

const settingsUpdateSchema = z.object({
  backend: z.enum(["claude-cli", "codex-cli", "foundry"]).optional(),
  claudeCliModel: z.string().min(1).optional(),
  codexCliModel: z.string().optional()
});

export function registerApiRoutes(app: Express, service: UiServerService): void {
  app.get("/api/settings", (_req, res) => {
    res.json(service.getSettings());
  });

  app.patch("/api/settings", (req, res) => {
    try {
      const raw = settingsUpdateSchema.parse(req.body);
      const payload: Partial<BackendSettings> = {};
      if (raw.backend !== undefined) payload.backend = raw.backend;
      if (raw.claudeCliModel !== undefined) payload.claudeCliModel = raw.claudeCliModel;
      if (raw.codexCliModel !== undefined) payload.codexCliModel = raw.codexCliModel;
      service.updateSettings(payload);
      res.json(service.getSettings());
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues.map((i) => i.message).join("; ") });
        return;
      }
      res.status(400).json({ error: "Invalid settings" });
    }
  });

  app.post("/api/sessions", async (req, res) => {
    await handleAsync(req, res, async () => {
      const payload = createSessionSchema.parse(req.body);
      const session = await service.createSession(payload.prUrl);
      res.status(201).json(session);
    });
  });

  app.get("/api/sessions/:id", async (req, res) => {
    await handleAsync(req, res, async () => {
      res.json(service.getSessionOverview(req.params.id ?? ""));
    });
  });

  app.patch("/api/sessions/:id", async (req, res) => {
    await handleAsync(req, res, async () => {
      const payload = reviewSummarySchema.parse(req.body);
      service.setReviewSummary(req.params.id ?? "", payload.reviewSummary);
      res.status(204).end();
    });
  });

  app.get("/api/sessions/:id/files/*", async (req, res) => {
    await handleAsync(req, res, async () => {
      const pathParam = extractFilePath(req);
      res.json(service.getFile(req.params.id ?? "", pathParam));
    });
  });

  app.post("/api/sessions/:id/drafts", async (req, res) => {
    await handleAsync(req, res, async () => {
      const payload = updateDraftSchema.parse(req.body);
      const draft = service.saveDraft(req.params.id ?? "", {
        path: payload.path,
        body: payload.body,
        side: payload.side,
        startRowKey: payload.startRowKey,
        endRowKey: payload.endRowKey,
        ...(payload.id ? { id: payload.id } : {})
      });
      res.status(201).json(draft);
    });
  });

  app.delete("/api/sessions/:id/drafts/:draftId", async (req, res) => {
    await handleAsync(req, res, async () => {
      service.deleteDraft(req.params.id ?? "", req.params.draftId ?? "");
      res.status(204).end();
    });
  });

  app.post("/api/sessions/:id/reviews", async (req, res) => {
    await handleAsync(req, res, async () => {
      const payload = submitReviewSchema.parse(req.body);
      const reviewPayload: ReviewSubmissionPayload = payload.event
        ? { body: payload.body, event: payload.event }
        : { body: payload.body };
      res.status(201).json(
        await service.submitReview(req.params.id ?? "", reviewPayload)
      );
    });
  });

  app.post("/api/sessions/:id/ai-review", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const abort = new AbortController();
    req.on("close", () => { abort.abort(); });

    const writeEvent = (event: string, data: unknown) => {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    try {
      const result = await service.runAiReview(
        req.params.id ?? "",
        (message) => { writeEvent("progress", { message }); },
        abort.signal
      );
      writeEvent("result", result);
    } catch (error) {
      if (!abort.signal.aborted) {
        writeEvent("error", { error: error instanceof Error ? error.message : "Unknown error" });
      }
    } finally {
      res.end();
    }
  });

  app.post("/api/sessions/:id/annotation-chat", async (req, res) => {
    await handleAsync(req, res, async () => {
      const payload = annotationChatSchema.parse(req.body);
      res.json(await service.sendAnnotationChat(
        req.params.id ?? "",
        payload.context,
        payload.body,
        payload.path,
        payload.thread,
        payload.message
      ));
    });
  });

  app.post("/api/sessions/:id/chat", async (req, res) => {
    await handleAsync(req, res, async () => {
      const { message } = z.object({ message: z.string().min(1) }).parse(req.body);
      res.json(await service.sendChatMessage(req.params.id ?? "", message));
    });
  });
}

async function handleAsync(
  _req: Request,
  res: Response,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map((issue) => issue.message).join("; ") });
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = /not found/i.test(message) ? 404 : 400;
    res.status(status).json({ error: message });
  }
}

function extractFilePath(req: Request): string {
  const sessionId = req.params.id ?? "";
  const marker = `/api/sessions/${sessionId}/files/`;
  const start = req.originalUrl.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const rawPath = req.originalUrl.slice(start + marker.length).split("?")[0] ?? "";
  return decodeURIComponent(rawPath);
}
