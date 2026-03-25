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
import {
  createWalkthroughSession,
  runSessionRepl,
  type InteractiveOptions
} from "./interactive-session.js";
import { loadSession } from "./session-store.js";

function readEnvSecret(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseModelPreset(raw: string | undefined): ModelPreset {
  const model = (raw ?? "haiku") as ModelPreset;
  if (model !== "sonnet" && model !== "haiku") {
    throw new Error(`Unsupported model preset: ${raw}`);
  }
  return model;
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

async function resolveInteractiveOptions(options: {
  model?: string;
  verbose?: boolean;
  promptFile?: string;
  promptForGithubToken?: boolean;
  promptForAzureKey?: boolean;
}): Promise<InteractiveOptions> {
  const model = parseModelPreset(options.model);

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
    promptFile: undefined,
    jsonOutput: undefined
  });

  const result: InteractiveOptions = {
    model,
    githubToken,
    azureFoundryBaseUrl: config.azureFoundryBaseUrl,
    azureFoundryApiKey,
    deploymentName: config.deploymentName,
    verbose: Boolean(options.verbose)
  };
  if (options.promptFile) {
    result.promptFile = path.resolve(options.promptFile);
  }
  return result;
}

async function runOneShotReview(
  prUrl: string,
  options: {
    model?: string;
    promptFile?: string;
    jsonOutput?: string;
    verbose?: boolean;
    promptForGithubToken?: boolean;
    promptForAzureKey?: boolean;
  }
): Promise<void> {
  const model = parseModelPreset(options.model);

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

function buildProgram(): Command {
  const program = new Command();

  program
    .name("gh-pr-review")
    .description("Review GitHub pull requests with Claude on Azure Foundry");

  // ── Default: interactive walkthrough mode ───────────────────────────────
  program
    .argument("[pr-url]", "GitHub pull request URL")
    .option("--model <preset>", "Model preset: sonnet or haiku", "haiku")
    .option("--verbose", "Show detailed progress logs")
    .option("--prompt-for-github-token", "Prompt for GitHub token if env var is unset")
    .option("--prompt-for-azure-key", "Prompt for Azure key if env var is unset")
    .action(async (prUrl: string | undefined, options) => {
      if (!prUrl) {
        program.help();
        return;
      }
      const interactiveOpts = await resolveInteractiveOptions(options);
      const session = await createWalkthroughSession(prUrl, interactiveOpts);
      await runSessionRepl(session, interactiveOpts, true);
    });

  // ── one-shot <pr-url>: non-interactive output (for automation/json) ──────
  const oneShotCmd = new Command("one-shot")
    .description("Non-interactive review: print markdown and optional JSON output")
    .argument("<pr-url>", "GitHub pull request URL")
    .option("--model <preset>", "Model preset: sonnet or haiku", "haiku")
    .option("--prompt-file <path>", "Path to a review prompt file")
    .option("--json-output <path>", "Write structured JSON output to a file")
    .option("--verbose", "Show detailed progress logs")
    .option("--prompt-for-github-token", "Prompt for GitHub token if env var is unset")
    .option("--prompt-for-azure-key", "Prompt for Azure key if env var is unset")
    .action(async (prUrl: string, options) => {
      await runOneShotReview(prUrl, options);
    });

  // ── walkthrough <pr-url> ─────────────────────────────────────────────────
  const walkthroughCmd = new Command("walkthrough")
    .description("Start an interactive walkthrough session for a PR")
    .argument("<pr-url>", "GitHub pull request URL")
    .option("--model <preset>", "Model preset: sonnet or haiku", "haiku")
    .option("--prompt-file <path>", "Path to a custom prompt file")
    .option("--verbose", "Show detailed progress logs")
    .option("--prompt-for-github-token", "Prompt for GitHub token if env var is unset")
    .option("--prompt-for-azure-key", "Prompt for Azure key if env var is unset")
    .action(async (prUrl: string, options) => {
      const interactiveOpts = await resolveInteractiveOptions(options);
      const session = await createWalkthroughSession(prUrl, interactiveOpts);
      await runSessionRepl(session, interactiveOpts, true);
    });

  // ── resume <session-id> ──────────────────────────────────────────────────
  const resumeCmd = new Command("resume")
    .description("Resume an existing interactive session")
    .argument("<session-id>", "Session ID to resume")
    .option("--prompt-for-github-token", "Prompt for GitHub token if env var is unset")
    .option("--prompt-for-azure-key", "Prompt for Azure key if env var is unset")
    .action(async (sessionId: string, options) => {
      const session = loadSession(sessionId);
      const interactiveOpts = await resolveInteractiveOptions({
        ...options,
        model: session.model // use session's model, not CLI default
      });
      await runSessionRepl(session, interactiveOpts, false);
    });

  program.addCommand(oneShotCmd);
  program.addCommand(walkthroughCmd);
  program.addCommand(resumeCmd);

  return program;
}

async function run(argv = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
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
