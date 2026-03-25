import { ModelPreset, type AppConfig } from "./types.js";

export interface ResolveConfigOptions {
  model: ModelPreset;
  githubToken: string;
  azureFoundryApiKey: string;
  promptFile: string | undefined;
  jsonOutput: string | undefined;
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

  const config: AppConfig = {
    githubToken: options.githubToken,
    azureFoundryApiKey: options.azureFoundryApiKey,
    azureFoundryBaseUrl,
    selectedModel: options.model,
    deploymentName: resolveDeploymentName(options.model)
  };

  if (options.promptFile) {
    config.promptFile = options.promptFile;
  }
  if (options.jsonOutput) {
    config.jsonOutput = options.jsonOutput;
  }

  return config;
}

export function resolvePromptFile(flagValue?: string): string | undefined {
  return flagValue ?? process.env.PR_REVIEW_PROMPT_FILE?.trim() ?? undefined;
}

export { ModelPreset };
