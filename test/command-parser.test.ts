import { describe, expect, it } from "vitest";

import { parseCommand } from "../src/services/interactive-session.js";

describe("parseCommand", () => {
  it("parses 'next'", () => {
    expect(parseCommand("next")).toEqual({ type: "next" });
  });

  it("parses 'ok' as next", () => {
    expect(parseCommand("ok")).toEqual({ type: "next" });
  });

  it("parses 'continue' as next", () => {
    expect(parseCommand("continue")).toEqual({ type: "next" });
  });

  it("parses '下一個' as next", () => {
    expect(parseCommand("下一個")).toEqual({ type: "next" });
  });

  it("parses 'next' case-insensitively", () => {
    expect(parseCommand("NEXT")).toEqual({ type: "next" });
    expect(parseCommand("Next")).toEqual({ type: "next" });
  });

  it("parses 'jump <path>'", () => {
    expect(parseCommand("jump src/foo.ts")).toEqual({
      type: "jump",
      filePath: "src/foo.ts"
    });
  });

  it("parses 'jump' with path containing spaces (trimmed)", () => {
    expect(parseCommand("jump  src/foo bar.ts")).toEqual({
      type: "jump",
      filePath: "src/foo bar.ts"
    });
  });

  it("parses 'status'", () => {
    expect(parseCommand("status")).toEqual({ type: "status" });
  });

  it("parses 'exit'", () => {
    expect(parseCommand("exit")).toEqual({ type: "exit" });
  });

  it("parses 'quit' as exit", () => {
    expect(parseCommand("quit")).toEqual({ type: "exit" });
  });

  it("parses 'q' as exit", () => {
    expect(parseCommand("q")).toEqual({ type: "exit" });
  });

  it("parses unknown input as followup", () => {
    expect(parseCommand("what does this do?")).toEqual({
      type: "followup",
      text: "what does this do?"
    });
  });

  it("parses empty string as followup with empty text", () => {
    expect(parseCommand("")).toEqual({ type: "followup", text: "" });
  });

  it("trims leading/trailing whitespace before matching", () => {
    expect(parseCommand("  next  ")).toEqual({ type: "next" });
    expect(parseCommand("  exit  ")).toEqual({ type: "exit" });
  });
});
