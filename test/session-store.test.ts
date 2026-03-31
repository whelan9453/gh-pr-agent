import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveArtifacts, saveSession } from "../src/services/session-store.js";
import type { AppSession, PullRequestRef, SessionArtifacts } from "../src/types.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_HOME = process.env.HOME;

function makePrRef(): PullRequestRef {
  return {
    host: "github.com",
    owner: "openai",
    repo: "codex",
    number: 123,
    url: "https://github.com/openai/codex/pull/123",
    apiBaseUrl: "https://api.github.com"
  };
}

function makeSession(id: string, updatedAt: string): AppSession {
  return {
    id,
    mode: "walkthrough",
    prRef: makePrRef(),
    model: "haiku",
    prTitle: `Session ${id}`,
    snapshotSha: "abc1234",
    createdAt: updatedAt,
    updatedAt,
    cursor: {
      mode: "walkthrough",
      fileIndex: 0,
      walkthroughOrder: ["src/app.ts"]
    },
    messages: []
  };
}

function makeArtifacts(): SessionArtifacts {
  return {
    prInfo: {
      title: "Test PR",
      body: "",
      state: "open",
      author: "tester",
      base: "main",
      baseSha: "base123",
      head: "feature",
      headSha: "head123",
      additions: 1,
      deletions: 0,
      changedFiles: 1
    },
    prContext: {
      description: "",
      issueComments: [],
      reviews: [],
      reviewComments: []
    },
    files: [],
    walkthroughOrder: [],
    drafts: [],
    reviewSummary: "",
    chatHistory: []
  };
}

function sessionsDir(home: string): string {
  return path.join(home, ".gh-pr-agent", "sessions");
}

beforeEach(() => {
  const home = mkdtempSync(path.join(os.tmpdir(), "gh-pr-agent-home-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "gh-pr-agent-cwd-"));
  process.env.HOME = home;
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  process.env.HOME = ORIGINAL_HOME;
});

describe("session retention", () => {
  it("removes sessions older than 30 days along with their artifacts", () => {
    const home = process.env.HOME!;
    const dir = sessionsDir(home);
    mkdirSync(dir, { recursive: true });

    const oldUpdatedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(path.join(dir, "old.json"), JSON.stringify(makeSession("old", oldUpdatedAt)), "utf8");
    writeFileSync(path.join(dir, "old-artifacts.json"), JSON.stringify(makeArtifacts()), "utf8");

    const currentId = "current";
    const currentUpdatedAt = new Date().toISOString();
    saveArtifacts(currentId, makeArtifacts());
    saveSession(makeSession(currentId, currentUpdatedAt));

    expect(existsSync(path.join(dir, "old.json"))).toBe(false);
    expect(existsSync(path.join(dir, "old-artifacts.json"))).toBe(false);
    expect(existsSync(path.join(dir, "current.json"))).toBe(true);
    expect(existsSync(path.join(dir, "current-artifacts.json"))).toBe(true);
  });

  it("keeps only the 100 most recent sessions", () => {
    const home = process.env.HOME!;
    const dir = sessionsDir(home);
    mkdirSync(dir, { recursive: true });

    const baseTime = Date.now();
    for (let index = 0; index < 100; index += 1) {
      const id = `existing-${index}`;
      const updatedAt = new Date(baseTime - (index + 1) * 60_000).toISOString();
      writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(makeSession(id, updatedAt)), "utf8");
      writeFileSync(path.join(dir, `${id}-artifacts.json`), JSON.stringify(makeArtifacts()), "utf8");
    }

    saveArtifacts("current", makeArtifacts());
    saveSession(makeSession("current", new Date(baseTime + 60_000).toISOString()));

    const remainingSessions = readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.endsWith("-artifacts.json"))
      .sort();

    expect(remainingSessions).toHaveLength(100);
    expect(remainingSessions).toContain("current.json");
    expect(remainingSessions).not.toContain("existing-99.json");
    expect(remainingSessions).toContain("existing-0.json");
    expect(existsSync(path.join(dir, "existing-99-artifacts.json"))).toBe(false);
    expect(existsSync(path.join(dir, "existing-0-artifacts.json"))).toBe(true);
  });
});
