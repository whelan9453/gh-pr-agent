import { makeConversationClient } from "../clients/conversation-client.js";
import type { AppConfig } from "../types.js";
import {
  createSavedSession,
  deleteDraftComment,
  getFileMaterial,
  getSessionOverview,
  setReviewSummary,
  upsertDraftComment
} from "../services/session.js";
import {
  runAiReview,
  sendAnnotationChatMessage,
  sendChatMessage,
  submitReview
} from "../services/review-ops.js";
import { loadArtifacts } from "../services/session-store.js";
import type { BackendSettings, UiServerService } from "./types.js";

function getBackendLabel(backend: BackendSettings["backend"]): string {
  if (backend === "codex-cli") return "Codex CLI";
  if (backend === "opencode-cli") return "OpenCode CLI";
  if (backend === "claude-cli") return "Claude CLI";
  return "Azure Foundry";
}

export function createDefaultUiServerService(config: AppConfig): UiServerService {
  let settings: BackendSettings = {
    backend: config.backend ?? "codex-cli",
    claudeCliModel: config.claudeCliModel ?? "claude-sonnet-4-6",
    codexCliModel: config.codexCliModel ?? "",
    opencodeCliModel: config.opencodeCliModel ?? "github-copilot/claude-sonnet-4.6"
  };

  let cachedClient = makeConversationClient({
    backend: settings.backend,
    azureFoundryBaseUrl: config.azureFoundryBaseUrl,
    azureFoundryApiKey: config.azureFoundryApiKey,
    deploymentName: config.deploymentName,
    claudeCliModel: settings.claudeCliModel,
    codexCliModel: settings.codexCliModel,
    opencodeCliModel: settings.opencodeCliModel
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
      return runAiReview(sessionId, getClient(), onProgress, signal, getBackendLabel(settings.backend));
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
        codexCliModel: settings.codexCliModel,
        opencodeCliModel: settings.opencodeCliModel
      });
    }
  };
}
