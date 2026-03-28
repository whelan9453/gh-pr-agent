import express, { type Express, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createSavedSession,
  deleteDraftComment,
  getFileMaterial,
  getSessionOverview,
  runAiReview,
  sendAnnotationChatMessage,
  sendChatMessage,
  setReviewSummary,
  submitReview,
  upsertDraftComment,
  type DraftCommentInput,
  type SessionOverview
} from "./review-session.js";
import { loadArtifacts } from "./session-store.js";
import { makeConversationClient, type ClientBackend } from "./conversation-client.js";
import type { AppConfig, DraftComment, FileMaterial, ModelPreset, ReviewSubmissionPayload } from "./types.js";

export interface BackendSettings {
  backend: ClientBackend;
  claudeCliModel: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

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
  runAiReview(sessionId: string, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<{ analysis: string; draftCount: number; comments: Array<{ context: string; severity: "must-fix" | "should-fix"; description: string; body: string; path: string | null; line: number | null }> }>;
  sendAnnotationChat(sessionId: string, context: string, body: string, path: string | null, thread: Array<{ role: "user" | "assistant"; content: string }>, message: string): Promise<{ reply: string }>;
  sendChatMessage(sessionId: string, message: string): Promise<{ reply: string }>;
  getSettings(): BackendSettings;
  updateSettings(settings: Partial<BackendSettings>): void;
}

interface CreateUiServerOptions {
  service: UiServerService;
  staticDir?: string;
}

export interface StartUiServerOptions {
  config: AppConfig;
  initialPrUrl?: string;
}

export function createDefaultUiServerService(config: AppConfig): UiServerService {
  let settings: BackendSettings = {
    backend: config.backend ?? "claude-cli",
    claudeCliModel: config.claudeCliModel ?? "claude-sonnet-4-6",
  };

  let cachedClient = makeConversationClient({
    backend: settings.backend,
    azureFoundryBaseUrl: config.azureFoundryBaseUrl,
    azureFoundryApiKey: config.azureFoundryApiKey,
    deploymentName: config.deploymentName,
    claudeCliModel: settings.claudeCliModel,
  });

  const getClient = () => cachedClient;

  return {
    async createSession(prUrl) {
      const session = await createSavedSession(prUrl, config.githubToken, config.selectedModel, "ui-review");
      return { sessionId: session.id };
    },
    getSessionOverview,
    getFile(sessionId, filePath) {
      const file = getFileMaterial(sessionId, filePath);
      const drafts = loadArtifacts(sessionId).drafts.filter((draft) => draft.path === filePath);
      return { file, drafts };
    },
    saveDraft: upsertDraftComment,
    deleteDraft: deleteDraftComment,
    setReviewSummary,
    async submitReview(sessionId, payload) {
      const result = await submitReview(sessionId, config.githubToken, payload);
      return { url: result.url, drafts: result.artifacts.drafts };
    },
    async runAiReview(sessionId, onProgress, signal) {
      return runAiReview(sessionId, getClient(), onProgress, signal);
    },
    async sendAnnotationChat(sessionId, context, body, path, thread, message) {
      return sendAnnotationChatMessage(sessionId, context, body, path, thread, message, getClient());
    },
    async sendChatMessage(sessionId, message) {
      return sendChatMessage(sessionId, message, getClient());
    },
    getSettings() {
      return { ...settings };
    },
    updateSettings(partial) {
      settings = { ...settings, ...partial };
      cachedClient = makeConversationClient({
        backend: settings.backend,
        azureFoundryBaseUrl: config.azureFoundryBaseUrl,
        azureFoundryApiKey: config.azureFoundryApiKey,
        deploymentName: config.deploymentName,
        claudeCliModel: settings.claudeCliModel,
      });
    },
  };
}

const settingsUpdateSchema = z.object({
  backend: z.enum(["claude-cli", "foundry"]).optional(),
  claudeCliModel: z.string().min(1).optional(),
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

export function createUiApp(options: CreateUiServerOptions): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  registerApiRoutes(app, options.service);

  const staticDir = options.staticDir ?? resolveUiBuildDir();
  if (!existsSync(join(staticDir, "index.html"))) {
    throw new Error(`Built UI assets not found at ${staticDir}. Run npm run build first.`);
  }

  app.use(express.static(staticDir));
  app.get("*", (_req, res) => {
    res.sendFile(join(staticDir, "index.html"));
  });

  return app;
}

export async function startUiServer(options: StartUiServerOptions): Promise<string> {
  const service = createDefaultUiServerService(options.config);
  const app = createUiApp({ service });
  const port = await listen(app);
  const url = new URL(`http://127.0.0.1:${port}/`);
  if (options.initialPrUrl) {
    url.searchParams.set("prUrl", options.initialPrUrl);
  }
  openBrowser(url.toString());
  return url.toString();
}

function resolveUiBuildDir(): string {
  const candidates = [
    join(MODULE_DIR, "..", "ui"),
    join(MODULE_DIR, "..", "dist", "ui"),
    join(MODULE_DIR, "..", "..", "dist", "ui")
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html")) && existsSync(join(candidate, "assets"))) {
      return candidate;
    }
  }
  return candidates[0] ?? join(MODULE_DIR, "..", "dist", "ui");
}

function listen(app: Express): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine UI server port."));
        return;
      }
      resolve(address.port);
    });
    server.on("error", reject);
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? { bin: "open", args: [url] }
    : process.platform === "win32"
      ? { bin: "cmd", args: ["/c", "start", "", url] }
      : { bin: "xdg-open", args: [url] };

  execFile(command.bin, command.args, (error) => {
    if (error) {
      process.stderr.write(`Open ${url} manually.\n`);
    }
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
