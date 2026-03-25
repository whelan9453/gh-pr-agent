import { afterEach, describe, expect, it } from "vitest";

import { resolveConfig, resolvePromptFile } from "../src/config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveConfig", () => {
  it("resolves sonnet deployment", () => {
    process.env.GITHUB_TOKEN = "gh";
    process.env.AZURE_FOUNDRY_API_KEY = "az";
    process.env.AZURE_FOUNDRY_BASE_URL = "https://example.services.ai.azure.com/anthropic";
    process.env.AZURE_FOUNDRY_SONNET_DEPLOYMENT = "claude-sonnet-4-6";

    const config = resolveConfig({
      model: "sonnet",
      githubToken: "gh",
      azureFoundryApiKey: "az",
      promptFile: undefined,
      jsonOutput: undefined
    });

    expect(config.deploymentName).toBe("claude-sonnet-4-6");
  });

  it("fails when haiku deployment is missing", () => {
    process.env.AZURE_FOUNDRY_BASE_URL = "https://example.services.ai.azure.com/anthropic";

    expect(() =>
      resolveConfig({
        model: "haiku",
        githubToken: "gh",
        azureFoundryApiKey: "az",
        promptFile: undefined,
        jsonOutput: undefined
      })
    ).toThrow("AZURE_FOUNDRY_HAIKU_DEPLOYMENT");
  });
});

describe("resolvePromptFile", () => {
  it("prefers flag over env", () => {
    process.env.PR_REVIEW_PROMPT_FILE = "/env/prompt.md";
    expect(resolvePromptFile("/flag/prompt.md")).toBe("/flag/prompt.md");
  });
});
