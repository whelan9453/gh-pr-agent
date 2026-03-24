import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appConfigPath,
  deletePersistedConfig,
  readPersistedConfig,
  writePersistedConfig
} from "../src/user-config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("user-config", () => {
  it("writes and reads persisted config from override dir", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "gh-pr-agent-"));
    process.env.GH_PR_AGENT_CONFIG_DIR = tempDir;

    await writePersistedConfig({
      azureFoundryBaseUrl: "https://example.services.ai.azure.com/anthropic",
      deployments: { haiku: "claude-haiku-4-5" },
      defaultModel: "haiku"
    });

    const stored = await readPersistedConfig();
    const raw = await readFile(appConfigPath(), "utf8");

    expect(stored.deployments?.haiku).toBe("claude-haiku-4-5");
    expect(raw).toContain("claude-haiku-4-5");

    await deletePersistedConfig();
    expect(await readPersistedConfig()).toEqual({});
  });
});
