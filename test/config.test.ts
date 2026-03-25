import { afterEach, describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveConfig", () => {
  it("resolves sonnet deployment", () => {
    process.env.AZURE_FOUNDRY_BASE_URL = "https://example.services.ai.azure.com/anthropic";
    process.env.AZURE_FOUNDRY_SONNET_DEPLOYMENT = "claude-sonnet-4-6";

    const config = resolveConfig({
      model: "sonnet",
      githubToken: "gh",
      azureFoundryApiKey: "az"
    });

    expect(config.deploymentName).toBe("claude-sonnet-4-6");
  });

  it("fails when haiku deployment is missing", () => {
    process.env.AZURE_FOUNDRY_BASE_URL = "https://example.services.ai.azure.com/anthropic";

    expect(() =>
      resolveConfig({
        model: "haiku",
        githubToken: "gh",
        azureFoundryApiKey: "az"
      })
    ).toThrow("AZURE_FOUNDRY_HAIKU_DEPLOYMENT");
  });
});
