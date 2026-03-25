#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { realpathSync } from "node:fs";
import path, { dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

loadDotenv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });

import { Command } from "commander";

import { ModelPreset, resolveConfig } from "./config.js";
import {
  createWalkthroughSession,
  runSessionRepl,
  type InteractiveOptions
} from "./interactive-session.js";
import { summarizePr } from "./summarize-pr.js";
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

  const config = resolveConfig({ model, githubToken, azureFoundryApiKey });

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

function buildProgram(): Command {
  const program = new Command();

  program
    .name("gh-pr-review")
    .description("Walk through a GitHub pull request with Claude");

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
        model: session.model
      });
      await runSessionRepl(session, interactiveOpts, false);
    });

  // ── summary <pr-url> ─────────────────────────────────────────────────────
  const summaryCmd = new Command("summary")
    .description("Quickly surface major issues in a PR without a full walkthrough")
    .argument("<pr-url>", "GitHub pull request URL")
    .option("--model <preset>", "Model preset: sonnet or haiku", "haiku")
    .option("--verbose", "Show detailed progress logs")
    .option("--prompt-for-github-token", "Prompt for GitHub token if env var is unset")
    .option("--prompt-for-azure-key", "Prompt for Azure key if env var is unset")
    .action(async (prUrl: string, options) => {
      const interactiveOpts = await resolveInteractiveOptions(options);
      await summarizePr(prUrl, interactiveOpts);
    });

  program.addCommand(walkthroughCmd);
  program.addCommand(summaryCmd);
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
