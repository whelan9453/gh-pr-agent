import readline from "node:readline";

import { deleteSecret, getSecret, keychainAvailable, setSecret } from "./keychain.js";
import { deletePersistedConfig, readPersistedConfig, writePersistedConfig } from "./user-config.js";
import { ModelPreset, PersistedConfig, StoredAuthStatus } from "./types.js";

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    const onDataHandler = (char: Buffer) => {
      const text = char.toString("utf8");
      if (text === "\n" || text === "\r" || text === "\u0004") {
        process.stdout.write("\n");
      } else {
        process.stdout.write("*");
      }
    };

    process.stdin.on("data", onDataHandler);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onDataHandler);
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askWithDefault(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await ask(`${question}${suffix}: `);
  return answer || defaultValue || "";
}

function mergeDeployments(
  existing: PersistedConfig["deployments"],
  updates: Partial<Record<ModelPreset, string>>
): Partial<Record<ModelPreset, string>> | undefined {
  const merged = {
    ...(existing ?? {}),
    ...updates
  };
  if (!merged.sonnet && !merged.haiku) {
    return undefined;
  }
  return merged;
}

export async function loginAndStoreAuth(): Promise<void> {
  if (!keychainAvailable()) {
    throw new Error("macOS Keychain is not available on this system.");
  }

  const existing = await readPersistedConfig();
  const githubToken = await askHidden("GitHub token: ");
  const azureFoundryApiKey = await askHidden("Azure Foundry API key: ");
  const azureFoundryBaseUrl = await askWithDefault(
    "Azure Foundry base URL",
    existing.azureFoundryBaseUrl
  );
  const haikuDeployment = await askWithDefault(
    "Haiku deployment name",
    existing.deployments?.haiku
  );
  const sonnetDeployment = await askWithDefault(
    "Sonnet deployment name (optional)",
    existing.deployments?.sonnet
  );
  const defaultModel = (await askWithDefault(
    "Default model preset (haiku or sonnet)",
    existing.defaultModel ?? "haiku"
  )) as ModelPreset;
  const promptFile = await askWithDefault("Default prompt file (optional)", existing.promptFile);

  if (!githubToken || !azureFoundryApiKey || !azureFoundryBaseUrl || !haikuDeployment) {
    throw new Error("GitHub token, Azure key, Azure base URL, and Haiku deployment are required.");
  }

  await setSecret("github-token", githubToken);
  await setSecret("azure-foundry-api-key", azureFoundryApiKey);
  const deployments = mergeDeployments(existing.deployments, {
    haiku: haikuDeployment,
    ...(sonnetDeployment ? { sonnet: sonnetDeployment } : {})
  });

  await writePersistedConfig({
    azureFoundryBaseUrl,
    defaultModel: defaultModel === "sonnet" ? "sonnet" : "haiku",
    ...(deployments ? { deployments } : {}),
    ...(promptFile ? { promptFile } : {})
  });
}

export async function loadStoredAuthStatus(): Promise<StoredAuthStatus> {
  const config = await readPersistedConfig();
  return {
    keychainAvailable: keychainAvailable(),
    githubTokenStored: keychainAvailable() ? Boolean(await getSecret("github-token")) : false,
    azureFoundryApiKeyStored: keychainAvailable()
      ? Boolean(await getSecret("azure-foundry-api-key"))
      : false,
    config
  };
}

export async function clearStoredAuth(removeConfig: boolean): Promise<void> {
  if (keychainAvailable()) {
    await deleteSecret("github-token");
    await deleteSecret("azure-foundry-api-key");
  }
  if (removeConfig) {
    await deletePersistedConfig();
  }
}
