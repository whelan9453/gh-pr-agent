#!/usr/bin/env node
import "dotenv/config";

import { realpathSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { ModelPreset, resolveConfig, resolvePromptFile } from "./config.js";
import { GitHubClient, parsePullRequestUrl } from "./github-client.js";
import { ClaudeFoundryClient } from "./model-client.js";
import { loadPrompt } from "./prompt-loader.js";
import { renderMarkdown, writeJsonOutput } from "./renderers.js";
import { ReviewEngine } from "./review-engine.js";

function readEnvSecret(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function writeProgress(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function promptHidden(question: string): Promise<string> {
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
    rl.question(`${question}: `, (answer) => {
      process.stdin.removeListener("data", onDataHandler);
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolveSecret(
  envName: "GITHUB_TOKEN" | "AZURE_FOUNDRY_API_KEY",
  shouldPrompt: boolean,
  message: string
): Promise<string> {
  const existing = readEnvSecret(envName);
  if (existing) {
    return existing;
  }
  if (!shouldPrompt) {
    throw new Error(`Missing required secret: ${envName}`);
  }
  const value = await promptHidden(message);
  if (!value) {
    throw new Error(`Missing required secret: ${envName}`);
  }
  return value;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("gh-pr-review")
    .description("Review GitHub pull requests with Claude on Azure Foundry")
    .argument("<pr-url>", "GitHub pull request URL")
    .option("--model <preset>", "Model preset: sonnet or haiku", "haiku")
    .option("--prompt-file <path>", "Path to a review prompt file")
    .option("--json-output <path>", "Write structured JSON output to a file")
    .option("--verbose", "Show detailed progress logs")
    .option("--prompt-for-github-token", "Prompt for GitHub token if env var is unset")
    .option("--prompt-for-azure-key", "Prompt for Azure key if env var is unset");

  return program;
}

export async function run(argv = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);

  const prUrl = program.args[0];
  if (!prUrl) {
    throw new Error("Missing pull request URL");
  }

  const options = program.opts<{
    model?: string;
    promptFile?: string;
    jsonOutput?: string;
    verbose?: boolean;
    promptForGithubToken?: boolean;
    promptForAzureKey?: boolean;
  }>();

  const model = (options.model ?? "haiku") as ModelPreset;
  if (model !== "sonnet" && model !== "haiku") {
    throw new Error(`Unsupported model preset: ${options.model}`);
  }

  const githubToken = await resolveSecret(
    "GITHUB_TOKEN",
    Boolean(options.promptForGithubToken),
    "GitHub token"
  );
  const azureFoundryApiKey = await resolveSecret(
    "AZURE_FOUNDRY_API_KEY",
    Boolean(options.promptForAzureKey),
    "Azure Foundry API key"
  );

  const config = resolveConfig({
    model,
    githubToken,
    azureFoundryApiKey,
    promptFile: resolvePromptFile(options.promptFile),
    jsonOutput: options.jsonOutput
  });

  writeProgress(`Starting review for ${prUrl}`);
  writeProgress(`Using ${model} deployment preset.`);
  if (options.verbose) {
    writeProgress("Loading review prompt...");
  }
  const prompt = await loadPrompt(config.promptFile);
  const pr = parsePullRequestUrl(prUrl);
  if (options.verbose) {
    writeProgress(`Resolved PR to ${pr.owner}/${pr.repo}#${pr.number}.`);
  }
  const githubClient = new GitHubClient(config.githubToken, pr.apiBaseUrl);
  const modelClient = new ClaudeFoundryClient(
    config.azureFoundryBaseUrl,
    config.azureFoundryApiKey,
    config.deploymentName,
    options.verbose
      ? {
          onVerbose: writeProgress
        }
      : undefined
  );
  const engine = new ReviewEngine(githubClient, modelClient, prompt, {
    onProgress: writeProgress,
    verbose: Boolean(options.verbose)
  });
  const report = await engine.reviewPullRequest(pr);

  if (options.verbose && config.jsonOutput) {
    writeProgress(`Writing JSON report to ${path.resolve(config.jsonOutput)}.`);
  }
  process.stdout.write(renderMarkdown(report));
  if (config.jsonOutput) {
    await writeJsonOutput(report, config.jsonOutput);
  }
}

const entrypoint = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const isEntrypoint =
  invokedPath !== null &&
  (() => {
    try {
      return realpathSync(invokedPath) === realpathSync(entrypoint);
    } catch {
      return invokedPath === entrypoint;
    }
  })();

if (isEntrypoint) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
