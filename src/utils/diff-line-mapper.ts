import type { DiffRow } from "../types.js";

const HUNK_RE = /^@@ -(?<old>\d+)(?:,\d+)? \+(?<new>\d+)(?:,\d+)? @@/;

export interface NumberedPatchResult {
  numberedPatch: string;
  validOldLines: Set<number>;
  validNewLines: Set<number>;
  changedNewLines: Set<number>;
  diffRows: DiffRow[];
}

export interface ContextResult {
  context: string;
  truncated: boolean;
}

interface PendingChangeLine {
  line: number;
  text: string;
}

export function buildNumberedPatch(patch: string): NumberedPatchResult {
  const rendered: string[] = [];
  const validOldLines = new Set<number>();
  const validNewLines = new Set<number>();
  const changedNewLines = new Set<number>();
  const diffRows: DiffRow[] = [];

  let oldLine = 0;
  let newLine = 0;
  let hunkIndex = -1;
  let rowIndex = 0;
  let pendingDeletes: PendingChangeLine[] = [];
  let pendingAdds: PendingChangeLine[] = [];

  const flushPendingChanges = (): void => {
    while (pendingDeletes.length > 0 || pendingAdds.length > 0) {
      const del = pendingDeletes.shift() ?? null;
      const add = pendingAdds.shift() ?? null;
      diffRows.push({
        key: `h${hunkIndex}-r${rowIndex}`,
        hunkIndex,
        type: del ? "del" : "add",
        header: null,
        oldLine: del?.line ?? null,
        newLine: add?.line ?? null,
        leftText: del?.text ?? "",
        rightText: add?.text ?? "",
        leftSelectable: del !== null,
        rightSelectable: add !== null
      });
      rowIndex += 1;
    }
  };

  for (const rawLine of patch.split("\n")) {
    const hunkMatch = HUNK_RE.exec(rawLine);
    if (hunkMatch?.groups) {
      flushPendingChanges();
      oldLine = Number(hunkMatch.groups.old);
      newLine = Number(hunkMatch.groups.new);
      hunkIndex += 1;
      rowIndex = 0;
      rendered.push(rawLine);
      diffRows.push({
        key: `h${hunkIndex}-header`,
        hunkIndex,
        type: "hunk",
        header: rawLine,
        oldLine: null,
        newLine: null,
        leftText: rawLine,
        rightText: rawLine,
        leftSelectable: false,
        rightSelectable: false
      });
      continue;
    }

    const prefix = rawLine.slice(0, 1);
    const body = rawLine.slice(1);

    if (prefix === "+") {
      rendered.push(`[new:${newLine}] +${body}`);
      validNewLines.add(newLine);
      changedNewLines.add(newLine);
      pendingAdds.push({ line: newLine, text: body });
      newLine += 1;
      continue;
    }

    if (prefix === "-") {
      rendered.push(`[old:${oldLine}] -${body}`);
      validOldLines.add(oldLine);
      pendingDeletes.push({ line: oldLine, text: body });
      oldLine += 1;
      continue;
    }

    if (prefix === " ") {
      flushPendingChanges();
      rendered.push(`[new:${newLine}]  ${body}`);
      validOldLines.add(oldLine);
      validNewLines.add(newLine);
      diffRows.push({
        key: `h${hunkIndex}-r${rowIndex}`,
        hunkIndex,
        type: "context",
        header: null,
        oldLine,
        newLine,
        leftText: body,
        rightText: body,
        leftSelectable: true,
        rightSelectable: true
      });
      rowIndex += 1;
      oldLine += 1;
      newLine += 1;
      continue;
    }

    flushPendingChanges();
    rendered.push(rawLine);
  }

  flushPendingChanges();

  return {
    numberedPatch: rendered.join("\n"),
    validOldLines,
    validNewLines,
    changedNewLines,
    diffRows
  };
}

export function buildNumberedContext(
  content: string,
  focusLines: Iterable<number>,
  contextRadius = 15,
  maxChars = 16000
): ContextResult {
  const lines = content.split("\n");
  const sortedFocus = Array.from(new Set(focusLines)).filter((line) => line > 0).sort(
    (a, b) => a - b
  );

  if (lines.length === 0 || sortedFocus.length === 0) {
    return { context: "", truncated: false };
  }

  const windows: Array<[number, number]> = [];
  for (const line of sortedFocus) {
    const start = Math.max(1, line - contextRadius);
    const end = Math.min(lines.length, line + contextRadius);
    const previous = windows.at(-1);
    if (previous && start <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], end);
    } else {
      windows.push([start, end]);
    }
  }

  const rendered: string[] = [];
  for (const [index, window] of windows.entries()) {
    if (index > 0) {
      rendered.push("...");
    }
    for (let lineNo = window[0]; lineNo <= window[1]; lineNo += 1) {
      rendered.push(`${String(lineNo).padStart(5, " ")} | ${lines[lineNo - 1] ?? ""}`);
    }
  }

  const fullContext = rendered.join("\n");
  if (fullContext.length <= maxChars) {
    return { context: fullContext, truncated: false };
  }

  return {
    context: `${fullContext.slice(0, maxChars)}\n...[truncated context]`,
    truncated: true
  };
}

export function truncateText(text: string, maxChars: number, label: string): ContextResult {
  if (text.length <= maxChars) {
    return { context: text, truncated: false };
  }

  return {
    context: `${text.slice(0, maxChars)}\n...[truncated ${label}]`,
    truncated: true
  };
}
