import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: timeoutMs });
    return { stdout, code: 0 };
  } catch (error: unknown) {
    const stdout =
      error !== null && typeof error === "object" && "stdout" in error
        ? String((error as { stdout: unknown }).stdout)
        : "";
    return { stdout, code: 1 };
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const { code } = await runWithTimeout("git", ["-C", cwd, "rev-parse", "--show-toplevel"], 3_000);
  return code === 0;
}

export async function gitRemoteMatchesPr(cwd: string, owner: string, repo: string): Promise<boolean> {
  const { code, stdout } = await runWithTimeout("git", ["-C", cwd, "remote", "-v"], 3_000);
  if (code !== 0) return false;
  const pattern = new RegExp(`[:/]${owner}/${repo}(?:\\.git)?(?:[/\\s]|$)`, "i");
  return stdout.split("\n").some((line) => line.includes("(fetch)") && pattern.test(line));
}

export async function isCodexCliAvailable(): Promise<boolean> {
  const cmd = process.platform === "win32" ? "where" : "which";
  const { code } = await runWithTimeout(cmd, ["codex"], 2_000);
  return code === 0;
}

export async function runCodexLocalReview(
  base: string,
  signal?: AbortSignal
): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }

    let stdout = "";
    let settled = false;

    const resolveOnce = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("codex", ["review", "--base", base], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      resolveOnce(null);
      return;
    }

    const timeout = setTimeout(() => {
      proc.kill();
      resolveOnce(null);
    }, 120_000);

    const onAbort = () => {
      clearTimeout(timeout);
      proc.kill();
      resolveOnce(null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      resolveOnce(code === 0 && stdout.trim() ? stdout.trim() : null);
    });

    proc.on("error", () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolveOnce(null);
    });
  });
}
