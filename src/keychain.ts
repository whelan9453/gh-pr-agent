import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE_NAME = "gh-pr-agent";

export type KeychainSecretName = "github-token" | "azure-foundry-api-key";

function ensureSupported(): void {
  if (process.platform !== "darwin") {
    throw new Error("Keychain storage is currently implemented for macOS only.");
  }
}

async function runSecurity(args: string[]): Promise<string> {
  ensureSupported();
  const { stdout } = await execFileAsync("/usr/bin/security", args, { encoding: "utf8" });
  return stdout;
}

export function keychainAvailable(): boolean {
  return process.platform === "darwin";
}

export async function getSecret(name: KeychainSecretName): Promise<string | undefined> {
  try {
    const output = await runSecurity([
      "find-generic-password",
      "-a",
      name,
      "-s",
      SERVICE_NAME,
      "-w"
    ]);
    return output.trim() || undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("could not be found")) {
      return undefined;
    }
    throw error;
  }
}

export async function setSecret(name: KeychainSecretName, value: string): Promise<void> {
  await runSecurity([
    "add-generic-password",
    "-U",
    "-a",
    name,
    "-s",
    SERVICE_NAME,
    "-w",
    value
  ]);
}

export async function deleteSecret(name: KeychainSecretName): Promise<void> {
  try {
    await runSecurity([
      "delete-generic-password",
      "-a",
      name,
      "-s",
      SERVICE_NAME
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("could not be found")) {
      throw error;
    }
  }
}
