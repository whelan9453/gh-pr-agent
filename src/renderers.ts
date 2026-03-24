import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { FileReview, ReviewReport } from "./types.js";

function renderFileReview(file: FileReview): string[] {
  const lines = [`## ${file.path}`, ""];

  if (file.previousPath) {
    lines.push(`Previous path: ${file.previousPath}`);
    lines.push("");
  }

  if (file.skipped) {
    lines.push(`Skipped: ${file.skipReason ?? "Unknown skip reason"}`);
    return lines;
  }

  if (file.reviewFailed) {
    lines.push(`Review failed: ${file.reviewFailureReason ?? "Unknown model failure"}`);
    return lines;
  }

  if (file.truncated) {
    lines.push("Note: input was truncated before review.");
    lines.push("");
  }

  lines.push("Change highlights:");
  if (file.summary.length === 0) {
    lines.push("- No summary returned.");
  } else {
    for (const item of file.summary) {
      lines.push(`- ${item}`);
    }
  }

  lines.push("");
  lines.push("Possible issues:");
  if (file.issues.length === 0) {
    lines.push("- No clear issue found in this file.");
  } else {
    for (const issue of file.issues) {
      const location = issue.line === null ? "no stable line" : `line ${issue.line}`;
      lines.push(
        `- [${issue.severity}/${issue.confidence}] ${issue.title} (${location}): ${issue.details}`
      );
    }
  }

  return lines;
}

export function renderMarkdown(report: ReviewReport): string {
  const lines = [
    `# Review: ${report.pullRequest.owner}/${report.pullRequest.repo}#${report.pullRequest.number}`,
    "",
    `- URL: ${report.pullRequest.url}`,
    `- Title: ${report.pullRequest.title}`,
    `- Base -> Head: ${report.pullRequest.base} -> ${report.pullRequest.head}`,
    `- Summary: ${report.overallSummary}`,
    ""
  ];

  for (const file of report.files) {
    lines.push(...renderFileReview(file), "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeJsonOutput(report: ReviewReport, outputPath: string): Promise<void> {
  const absolutePath = path.resolve(outputPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(report, null, 2), "utf8");
}
