import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import type { AppSession, SessionArtifacts } from "./types.js";

const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSION_COUNT = 100;

function findGhPrAgentDir(): string {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    return path.join(gitRoot, ".gh-pr-agent");
  } catch {
    return path.join(process.env.HOME ?? process.cwd(), ".gh-pr-agent");
  }
}

function sessionsDir(): string {
  return path.join(findGhPrAgentDir(), "sessions");
}

function ensureSessionsDir(): void {
  mkdirSync(sessionsDir(), { recursive: true });
}

export function generateSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

function artifactsPath(id: string): string {
  return path.join(sessionsDir(), `${id}-artifacts.json`);
}

export function saveSession(session: AppSession): void {
  ensureSessionsDir();
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
  pruneStoredSessions([session.id]);
}

export function loadSession(id: string): AppSession {
  const file = sessionPath(id);
  if (!existsSync(file)) {
    throw new Error(`Session not found: ${id}`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as AppSession;
}

export function saveArtifacts(sessionId: string, artifacts: SessionArtifacts): void {
  ensureSessionsDir();
  writeFileSync(artifactsPath(sessionId), JSON.stringify(artifacts, null, 2), "utf8");
  pruneStoredSessions([sessionId]);
}

export function loadArtifacts(sessionId: string): SessionArtifacts {
  const file = artifactsPath(sessionId);
  if (!existsSync(file)) {
    throw new Error(`Session artifacts not found: ${sessionId}`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as SessionArtifacts;
}

function pruneStoredSessions(protectedIds: string[] = []): void {
  const dir = sessionsDir();
  if (!existsSync(dir)) return;

  const protectedIdSet = new Set(protectedIds);
  const entries = readdirSync(dir);
  const sessionEntries = entries
    .filter((name) => name.endsWith(".json") && !name.endsWith("-artifacts.json"))
    .map((name) => {
      const file = path.join(dir, name);
      const fallbackTime = statSync(file).mtimeMs;
      const id = name.slice(0, -".json".length);
      let updatedAt = fallbackTime;

      try {
        const session = JSON.parse(readFileSync(file, "utf8")) as Partial<AppSession>;
        const parsedTime = Date.parse(session.updatedAt ?? session.createdAt ?? "");
        if (!Number.isNaN(parsedTime)) {
          updatedAt = parsedTime;
        }
      } catch {
        updatedAt = fallbackTime;
      }

      return { id, file, updatedAt };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const cutoff = Date.now() - MAX_SESSION_AGE_MS;
  const recentIds = new Set(
    sessionEntries
      .filter((entry) => entry.updatedAt >= cutoff)
      .slice(0, MAX_SESSION_COUNT)
      .map((entry) => entry.id)
  );

  for (const id of protectedIdSet) {
    recentIds.add(id);
  }

  for (const entry of sessionEntries) {
    if (!recentIds.has(entry.id)) {
      rmSync(entry.file, { force: true });
      rmSync(artifactsPath(entry.id), { force: true });
    }
  }

  for (const name of entries) {
    if (!name.endsWith("-artifacts.json")) continue;
    const id = name.slice(0, -"-artifacts.json".length);
    if (recentIds.has(id)) continue;
    if (protectedIdSet.has(id)) continue;
    rmSync(path.join(dir, name), { force: true });
  }
}
