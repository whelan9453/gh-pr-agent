import { getSecret } from "./keychain.js";
import { AppConfig, ModelPreset, PersistedConfig } from "./types.js";

export interface ResolveConfigOptions {
  model: ModelPreset;
  githubToken: string;
  azureFoundryApiKey: string;
  persistedConfig: PersistedConfig;
  promptFile: string | undefined;
  jsonOutput: string | undefined;
}

function readRequiredEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (fallback) {
    return fallback;
  }
  throw new Error(`Missing required environment variable: ${name}`);
}

function readOptionalEnv(name: string, fallback?: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || fallback;
}

export async function resolveSecretFromEnvOrStore(
  envName: "GITHUB_TOKEN" | "AZURE_FOUNDRY_API_KEY",
  storeName: "github-token" | "azure-foundry-api-key"
): Promise<string | undefined> {
  const value = process.env[envName]?.trim();
  if (value) {
    return value;
  }
  return getSecret(storeName);
}

function resolveDeploymentName(model: ModelPreset, persistedConfig: PersistedConfig): string {
  const envName =
    model === "sonnet" ? "AZURE_FOUNDRY_SONNET_DEPLOYMENT" : "AZURE_FOUNDRY_HAIKU_DEPLOYMENT";
  return readRequiredEnv(envName, persistedConfig.deployments?.[model]);
}

export function resolveConfig(options: ResolveConfigOptions): AppConfig {
  const azureFoundryBaseUrl = readRequiredEnv(
    "AZURE_FOUNDRY_BASE_URL",
    options.persistedConfig.azureFoundryBaseUrl
  ).replace(/\/+$/, "");

  if (!azureFoundryBaseUrl.startsWith("https://")) {
    throw new Error("AZURE_FOUNDRY_BASE_URL must start with https://");
  }

  const config: AppConfig = {
    githubToken: options.githubToken,
    azureFoundryApiKey: options.azureFoundryApiKey,
    azureFoundryBaseUrl,
    selectedModel: options.model,
    deploymentName: resolveDeploymentName(options.model, options.persistedConfig)
  };

  if (options.promptFile) {
    config.promptFile = options.promptFile;
  }
  if (options.jsonOutput) {
    config.jsonOutput = options.jsonOutput;
  }

  return config;
}

export function resolvePromptFile(
  flagValue: string | undefined,
  persistedConfig: PersistedConfig
): string | undefined {
  if (flagValue) {
    return flagValue;
  }
  return readOptionalEnv("PR_REVIEW_PROMPT_FILE", persistedConfig.promptFile);
}

export function resolveDefaultModel(persistedConfig: PersistedConfig): ModelPreset {
  const value = process.env.GH_PR_AGENT_DEFAULT_MODEL?.trim();
  if (value === "sonnet" || value === "haiku") {
    return value;
  }
  return persistedConfig.defaultModel ?? "haiku";
}

export { ModelPreset };
