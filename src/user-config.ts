import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PersistedConfig } from "./types.js";

function appConfigDir(): string {
  const override = process.env.GH_PR_AGENT_CONFIG_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "gh-pr-agent");
  }

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return path.join(xdg, "gh-pr-agent");
  }

  return path.join(os.homedir(), ".config", "gh-pr-agent");
}

export function appConfigPath(): string {
  return path.join(appConfigDir(), "config.json");
}

export async function readPersistedConfig(): Promise<PersistedConfig> {
  try {
    return JSON.parse(await readFile(appConfigPath(), "utf8")) as PersistedConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writePersistedConfig(config: PersistedConfig): Promise<void> {
  await mkdir(appConfigDir(), { recursive: true });
  await writeFile(appConfigPath(), JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
}

export async function deletePersistedConfig(): Promise<void> {
  await rm(appConfigPath(), { force: true });
}
