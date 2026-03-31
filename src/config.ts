import type { AppConfig, ModelPreset } from "./types.js";

const DEFAULT_TOTAL_PATCH_BUDGET = 200_000;

export function buildClaudeCliConfig(
  githubToken: string,
  model: ModelPreset,
  claudeCliModel?: string
): AppConfig {
  return {
    githubToken,
    azureFoundryBaseUrl: "",
    azureFoundryApiKey: "",
    selectedModel: model,
    deploymentName: "",
    ...(claudeCliModel ? { claudeCliModel } : {})
  };
}

interface ResolveConfigOptions {
  model: ModelPreset;
  githubToken: string;
  azureFoundryApiKey: string;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readOptionalPositiveIntEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function resolveDeploymentName(model: ModelPreset): string {
  const envName =
    model === "sonnet" ? "AZURE_FOUNDRY_SONNET_DEPLOYMENT" : "AZURE_FOUNDRY_HAIKU_DEPLOYMENT";
  return readRequiredEnv(envName);
}

export function resolveConfig(options: ResolveConfigOptions): AppConfig {
  const azureFoundryBaseUrl = readRequiredEnv("AZURE_FOUNDRY_BASE_URL").replace(/\/+$/, "");
  if (!azureFoundryBaseUrl.startsWith("https://")) {
    throw new Error("AZURE_FOUNDRY_BASE_URL must start with https://");
  }

  return {
    githubToken: options.githubToken,
    azureFoundryApiKey: options.azureFoundryApiKey,
    azureFoundryBaseUrl,
    selectedModel: options.model,
    deploymentName: resolveDeploymentName(options.model)
  };
}

export function getTotalPatchBudget(): number {
  return readOptionalPositiveIntEnv("TOTAL_PATCH_BUDGET") ?? DEFAULT_TOTAL_PATCH_BUDGET;
}
