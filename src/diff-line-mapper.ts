const HUNK_RE = /^@@ -(?<old>\d+)(?:,\d+)? \+(?<new>\d+)(?:,\d+)? @@/;

export interface NumberedPatchResult {
  numberedPatch: string;
  validNewLines: Set<number>;
  changedNewLines: Set<number>;
}

export interface ContextResult {
  context: string;
  truncated: boolean;
}

export function buildNumberedPatch(patch: string): NumberedPatchResult {
  const rendered: string[] = [];
  const validNewLines = new Set<number>();
  const changedNewLines = new Set<number>();
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of patch.split("\n")) {
    const hunkMatch = HUNK_RE.exec(rawLine);
    if (hunkMatch?.groups) {
      oldLine = Number(hunkMatch.groups.old);
      newLine = Number(hunkMatch.groups.new);
      rendered.push(rawLine);
      continue;
    }

    const prefix = rawLine.slice(0, 1);
    const body = rawLine.slice(1);

    if (prefix === "+") {
      rendered.push(`[new:${newLine}] +${body}`);
      validNewLines.add(newLine);
      changedNewLines.add(newLine);
      newLine += 1;
      continue;
    }

    if (prefix === "-") {
      rendered.push(`[old:${oldLine}] -${body}`);
      oldLine += 1;
      continue;
    }

    if (prefix === " ") {
      rendered.push(`[new:${newLine}]  ${body}`);
      validNewLines.add(newLine);
      oldLine += 1;
      newLine += 1;
      continue;
    }

    rendered.push(rawLine);
  }

  return {
    numberedPatch: rendered.join("\n"),
    validNewLines,
    changedNewLines
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
