import type { AppConfig, ModelPreset } from "./types.js";

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
