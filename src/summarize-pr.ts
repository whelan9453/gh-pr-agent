import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FoundryConversationClient } from "./conversation-client.js";
import { GitHubClient, parsePullRequestUrl } from "./github-client.js";
import { buildNumberedPatch } from "./diff-line-mapper.js";
import { buildPrContextBlock } from "./interactive-session.js";
import { renderToTerminal } from "./terminal-renderer.js";
import type { InteractiveOptions } from "./interactive-session.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const TOTAL_PATCH_BUDGET = 100_000;

interface SummaryComment {
  context: string;
  body: string;
  path: string | null;
  line: number | null;
}

function writeProgress(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function parseCommentsFromResponse(raw: string): { analysis: string; comments: SummaryComment[] } {
  const jsonFenceRe = /```json\s*([\s\S]*?)```\s*$/;
  const match = jsonFenceRe.exec(raw);
  if (!match) {
    return { analysis: raw, comments: [] };
  }

  const analysis = raw.slice(0, match.index).trimEnd();
  try {
    const parsed = JSON.parse(match[1] ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return { analysis, comments: [] };
    const comments = parsed.flatMap((c) => {
      if (typeof c !== "object" || c === null) return [];
      const r = c as Record<string, unknown>;
      if (typeof r["context"] !== "string" || typeof r["body"] !== "string") return [];
      return [{
        context: r["context"],
        body: r["body"],
        path: typeof r["path"] === "string" ? r["path"] : null,
        line: typeof r["line"] === "number" ? r["line"] : null
      }];
    });
    return { analysis, comments };
  } catch {
    return { analysis, comments: [] };
  }
}

async function promptSelection(comments: SummaryComment[]): Promise<SummaryComment[]> {
  if (comments.length === 0) return [];

  process.stdout.write("\n");
  for (const [i, c] of comments.entries()) {
    const location = c.path && c.line ? ` (${c.path}:${c.line})` : "";
    process.stdout.write(`  ${i + 1}. [${c.context}]${location}\n     ${c.body}\n\n`);
  }
  process.stdout.write(`Post which comments to GitHub? (e.g. 1,2 / all / none): `);

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const answer = await new Promise<string>((resolve) => {
    rl.once("line", (line) => { rl.close(); resolve(line.trim()); });
  });

  if (!answer || answer.toLowerCase() === "none" || answer.toLowerCase() === "n") {
    return [];
  }
  if (answer.toLowerCase() === "all" || answer.toLowerCase() === "a") {
    return comments;
  }

  const indices = answer.split(",").flatMap((s) => {
    const n = parseInt(s.trim(), 10);
    return Number.isFinite(n) && n >= 1 && n <= comments.length ? [n - 1] : [];
  });
  return [...new Set(indices)].map((i) => comments[i]).filter((c): c is SummaryComment => !!c);
}

export async function summarizePr(prUrl: string, opts: InteractiveOptions): Promise<void> {
  const pr = parsePullRequestUrl(prUrl);
  const github = new GitHubClient(opts.githubToken, pr.apiBaseUrl);

  writeProgress("Fetching PR metadata and comments...");
  const [prInfo, changedFiles, issueComments, reviews, reviewComments] = await Promise.all([
    github.getPullRequest(pr),
    github.listPullRequestFiles(pr),
    github.listIssueComments(pr),
    github.listReviews(pr),
    github.listReviewComments(pr)
  ]);
  writeProgress(`Loaded PR #${pr.number}: ${prInfo.title}`);
  writeProgress(`${changedFiles.length} file(s), ${reviews.length} review(s), ${issueComments.length + reviewComments.length} comment(s).`);

  const prContext = {
    description: prInfo.body,
    issueComments,
    reviews,
    reviewComments
  };

  const numberedPatches = changedFiles.map((f) =>
    f.patch ? buildNumberedPatch(f.patch).numberedPatch : null
  );
  const totalPatchChars = numberedPatches.reduce((sum, p) => sum + (p?.length ?? 0), 0);

  const fileBlocks = changedFiles.map((f, i) => {
    const parts = [`### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`];
    const patch = numberedPatches[i];
    if (patch) {
      let displayed = patch;
      if (totalPatchChars > TOTAL_PATCH_BUDGET) {
        const budget = Math.floor((patch.length / totalPatchChars) * TOTAL_PATCH_BUDGET);
        if (patch.length > budget) {
          displayed = patch.slice(0, budget) + "\n... (truncated)";
        }
      }
      parts.push("```diff", displayed, "```");
    } else {
      parts.push("(no textual diff)");
    }
    return parts.join("\n");
  });

  const prContextBlock = buildPrContextBlock(prContext);

  const userMessage = [
    `PR #${pr.number}: ${prInfo.title}`,
    `Author: ${prInfo.author}`,
    `Base: ${prInfo.base} → ${prInfo.head}`,
    `Changes: +${prInfo.additions} -${prInfo.deletions}, ${prInfo.changedFiles} files`,
    ...(prContextBlock ? ["", prContextBlock] : []),
    "",
    "## Changed Files",
    "",
    fileBlocks.join("\n\n")
  ].join("\n");

  const systemPrompt = await readFile(
    join(MODULE_DIR, "..", "prompts", "pr-summary.md"),
    "utf8"
  );

  writeProgress("Generating summary...");
  const client = new FoundryConversationClient(
    opts.azureFoundryBaseUrl,
    opts.azureFoundryApiKey,
    opts.deploymentName
  );

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: userMessage }
  ];

  const raw = await client.send(systemPrompt, messages, 1500);
  const { analysis, comments } = parseCommentsFromResponse(raw);

  messages.push({ role: "assistant", content: raw });

  process.stdout.write("\n" + renderToTerminal(analysis) + "\n");
  process.stdout.write("Commands: post — select comments to post | exit — quit\n");

  const postComments = async (currentComments: SummaryComment[]): Promise<void> => {
    if (currentComments.length === 0) {
      process.stdout.write("No comments to post.\n");
      return;
    }
    const selected = await promptSelection(currentComments);
    if (selected.length === 0) {
      process.stdout.write("No comments posted.\n");
      return;
    }

    writeProgress(`Posting ${selected.length} comment(s) to GitHub...`);

    const inlineComments = selected.filter((c) => c.path && c.line) as Array<
      SummaryComment & { path: string; line: number }
    >;
    const generalComments = selected.filter((c) => !c.path || !c.line);
    const reviewBody = generalComments.map((c) => c.body).join("\n\n");

    try {
      const url = await github.createReview(
        pr,
        prInfo.headSha,
        reviewBody,
        inlineComments.map((c) => ({ path: c.path, line: c.line, body: c.body }))
      );
      process.stdout.write(`  Posted review: ${url}\n`);
    } catch {
      const fallbackBody = selected.map((c) => {
        const loc = c.path && c.line ? `**${c.path}:${c.line}**\n` : "";
        return `${loc}${c.body}`;
      }).join("\n\n---\n\n");

      writeProgress("Inline comment failed (invalid line?), falling back to review body...");
      const url = await github.createReview(pr, prInfo.headSha, fallbackBody, []);
      process.stdout.write(`  Posted review: ${url}\n`);
    }
  };

  // Track latest comments in case follow-up responses update them
  let latestComments = comments;

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  const readLine = (): Promise<string> =>
    new Promise((resolve) => {
      process.stdout.write("\n> ");
      rl.once("line", (line) => resolve(line.trim()));
    });

  while (true) {
    const input = await readLine();

    if (!input) continue;

    if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
      process.stdout.write("Exiting without posting.\n");
      rl.close();
      break;
    }

    if (input.toLowerCase() === "post" || input.toLowerCase() === "send") {
      rl.close();
      await postComments(latestComments);
      break;
    }

    // Follow-up question — send to model with full conversation history
    messages.push({ role: "user", content: input });
    writeProgress("Thinking...");
    const followUp = await client.send(systemPrompt, messages, 1500);
    const parsed = parseCommentsFromResponse(followUp);
    if (parsed.comments.length > 0) {
      latestComments = parsed.comments;
    }
    messages.push({ role: "assistant", content: followUp });
    process.stdout.write("\n" + renderToTerminal(parsed.analysis) + "\n");
  }
}
