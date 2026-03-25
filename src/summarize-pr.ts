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

const MAX_PATCH_CHARS = 3000;

function writeProgress(msg: string): void {
  process.stderr.write(`${msg}\n`);
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

  // Build file patches block — truncate large patches to stay within token budget
  const fileBlocks = changedFiles.map((f) => {
    const parts = [`### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`];
    if (f.patch) {
      const { numberedPatch } = buildNumberedPatch(f.patch);
      const truncated = numberedPatch.length > MAX_PATCH_CHARS
        ? numberedPatch.slice(0, MAX_PATCH_CHARS) + "\n... (truncated)"
        : numberedPatch;
      parts.push("```diff", truncated, "```");
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

  const response = await client.send(systemPrompt, [{ role: "user", content: userMessage }], 1024);
  process.stdout.write("\n" + renderToTerminal(response) + "\n");
}
