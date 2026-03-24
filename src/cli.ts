import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { askHidden, clearStoredAuth, loadStoredAuthStatus, loginAndStoreAuth } from "./auth.js";
import {
  ModelPreset,
  resolveConfig,
  resolveDefaultModel,
  resolvePromptFile,
  resolveSecretFromEnvOrStore
} from "./config.js";
import { GitHubClient, parsePullRequestUrl } from "./github-client.js";
import { ClaudeFoundryClient } from "./model-client.js";
import { loadPrompt } from "./prompt-loader.js";
import { renderMarkdown, writeJsonOutput } from "./renderers.js";
import { ReviewEngine } from "./review-engine.js";
import { readPersistedConfig } from "./user-config.js";

async function resolveSecret(
  envName: "GITHUB_TOKEN" | "AZURE_FOUNDRY_API_KEY",
  storeName: "github-token" | "azure-foundry-api-key",
  shouldPrompt: boolean,
  message: string
): Promise<string> {
  const existing = await resolveSecretFromEnvOrStore(envName, storeName);
  if (existing) {
    return existing;
  }
  if (!shouldPrompt) {
    throw new Error(`Missing required secret: ${envName}`);
  }
  const value = await askHidden(`${message}: `);
  if (!value) {
    throw new Error(`Missing required secret: ${envName}`);
  }
  return value;
}

export function buildReviewProgram(): Command {
  const program = new Command();

  program
    .name("gh-pr-review")
    .description("Review GitHub pull requests with Claude on Azure Foundry")
    .argument("<pr-url>", "GitHub pull request URL")
    .option("--model <preset>", "Model preset: sonnet or haiku")
    .option("--prompt-file <path>", "Path to a review prompt file")
    .option("--json-output <path>", "Write structured JSON output to a file")
    .option("--prompt-for-github-token", "Prompt for GitHub token if no env var or Keychain secret exists")
    .option("--prompt-for-azure-key", "Prompt for Azure key if no env var or Keychain secret exists");

  program.addHelpText(
    "after",
    "\nCommands:\n  gh-pr-review auth login|status|logout  Manage stored credentials"
  );

  return program;
}

export function buildAuthProgram(): Command {
  const program = new Command();

  program.name("gh-pr-review auth").description("Manage stored credentials");

  program
    .command("login")
    .description("Store secrets in macOS Keychain and defaults in local user config")
    .action(async () => {
      await loginAndStoreAuth();
      process.stdout.write("Stored secrets in macOS Keychain and updated local config.\n");
    });

  program
    .command("status")
    .description("Show whether stored secrets and defaults are available")
    .action(async () => {
      const status = await loadStoredAuthStatus();
      process.stdout.write(`Keychain available: ${status.keychainAvailable}\n`);
      process.stdout.write(`GitHub token stored: ${status.githubTokenStored}\n`);
      process.stdout.write(`Azure API key stored: ${status.azureFoundryApiKeyStored}\n`);
      process.stdout.write(
        `Azure base URL configured: ${status.config.azureFoundryBaseUrl ? "yes" : "no"}\n`
      );
      process.stdout.write(
        `Haiku deployment configured: ${status.config.deployments?.haiku ?? "no"}\n`
      );
      process.stdout.write(
        `Sonnet deployment configured: ${status.config.deployments?.sonnet ?? "no"}\n`
      );
      process.stdout.write(`Default model: ${status.config.defaultModel ?? "haiku"}\n`);
      process.stdout.write(`Prompt file: ${status.config.promptFile ?? "not set"}\n`);
    });

  program
    .command("logout")
    .description("Remove stored secrets; add --all to remove local config too")
    .option("--all", "Also delete local non-secret config")
    .action(async (options: { all?: boolean }) => {
      await clearStoredAuth(Boolean(options.all));
      process.stdout.write(
        options.all ? "Removed stored secrets and local config.\n" : "Removed stored secrets.\n"
      );
    });

  return program;
}

export async function run(argv = process.argv): Promise<void> {
  if (argv[2] === "auth") {
    const program = buildAuthProgram();
    await program.parseAsync([argv[0] ?? "node", argv[1] ?? "gh-pr-review auth", ...argv.slice(3)]);
    return;
  }

  const program = buildReviewProgram();
  await program.parseAsync(argv);

  const prUrl = program.args[0];
  if (!prUrl) {
    throw new Error("Missing pull request URL");
  }

  const persistedConfig = await readPersistedConfig();
  const options = program.opts<{
    model?: string;
    promptFile?: string;
    jsonOutput?: string;
    promptForGithubToken?: boolean;
    promptForAzureKey?: boolean;
  }>();

  const model = (options.model ?? resolveDefaultModel(persistedConfig)) as ModelPreset;
  if (model !== "sonnet" && model !== "haiku") {
    throw new Error(`Unsupported model preset: ${options.model}`);
  }

  const githubToken = await resolveSecret(
    "GITHUB_TOKEN",
    "github-token",
    Boolean(options.promptForGithubToken),
    "GitHub token"
  );
  const azureFoundryApiKey = await resolveSecret(
    "AZURE_FOUNDRY_API_KEY",
    "azure-foundry-api-key",
    Boolean(options.promptForAzureKey),
    "Azure Foundry API key"
  );

  const config = resolveConfig({
    model,
    githubToken,
    azureFoundryApiKey,
    persistedConfig,
    promptFile: resolvePromptFile(options.promptFile, persistedConfig),
    jsonOutput: options.jsonOutput
  });

  const prompt = await loadPrompt(config.promptFile);
  const pr = parsePullRequestUrl(prUrl);
  const githubClient = new GitHubClient(config.githubToken, pr.apiBaseUrl);
  const modelClient = new ClaudeFoundryClient(
    config.azureFoundryBaseUrl,
    config.azureFoundryApiKey,
    config.deploymentName
  );
  const engine = new ReviewEngine(githubClient, modelClient, prompt);
  const report = await engine.reviewPullRequest(pr);

  process.stdout.write(renderMarkdown(report));
  if (config.jsonOutput) {
    await writeJsonOutput(report, config.jsonOutput);
  }
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entrypoint) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
