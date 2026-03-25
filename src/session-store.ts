import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AppSession, SessionArtifacts } from "./types.js";

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
  const dir = path.join(findGhPrAgentDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function generateSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

export function artifactsPath(id: string): string {
  return path.join(sessionsDir(), `${id}-artifacts.json`);
}

export function saveSession(session: AppSession): void {
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
}

export function loadSession(id: string): AppSession {
  const file = sessionPath(id);
  if (!existsSync(file)) {
    throw new Error(`Session not found: ${id}`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as AppSession;
}

export function saveArtifacts(sessionId: string, artifacts: SessionArtifacts): void {
  writeFileSync(artifactsPath(sessionId), JSON.stringify(artifacts, null, 2), "utf8");
}

export function loadArtifacts(sessionId: string): SessionArtifacts {
  const file = artifactsPath(sessionId);
  if (!existsSync(file)) {
    throw new Error(`Session artifacts not found: ${sessionId}`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as SessionArtifacts;
}
