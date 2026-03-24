import { ChangedFile, FileReview, PullRequestInfo, PullRequestRef, ReviewReport } from "./types.js";
import { buildNumberedContext, buildNumberedPatch, truncateText } from "./diff-line-mapper.js";
import { GitHubClient } from "./github-client.js";
import { ModelClient } from "./model-client.js";

const MAX_PATCH_CHARS = 8000;
const MAX_CONTEXT_CHARS = 4000;

export class ReviewEngine {
  constructor(
    private readonly githubClient: GitHubClient,
    private readonly modelClient: ModelClient,
    private readonly prompt: string
  ) {}

  async reviewPullRequest(pr: PullRequestRef): Promise<ReviewReport> {
    const prInfo = await this.githubClient.getPullRequest(pr);
    const files = await this.githubClient.listPullRequestFiles(pr);
    const reviews: FileReview[] = [];

    for (const file of files) {
      reviews.push(await this.reviewFile(pr, prInfo, file));
    }

    return {
      pullRequest: {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        title: prInfo.title,
        base: prInfo.base,
        head: prInfo.head
      },
      overallSummary: `${prInfo.changedFiles} file(s) changed, ${reviews.reduce((sum, file) => sum + file.issues.length, 0)} possible issue(s), ${reviews.filter((file) => file.skipped).length} skipped, ${reviews.filter((file) => file.reviewFailed).length} failed.`,
      files: reviews
    };
  }

  private async reviewFile(
    pr: PullRequestRef,
    prInfo: PullRequestInfo,
    file: ChangedFile
  ): Promise<FileReview> {
    if (process.env.GH_PR_AGENT_DEBUG === "1") {
      process.stderr.write(`review:start ${file.path}\n`);
    }

    if (!file.patch) {
      return {
        path: file.path,
        previousPath: file.previousPath,
        status: file.status,
        skipped: true,
        skipReason: "No textual patch was provided by GitHub for this file.",
        reviewFailed: false,
        reviewFailureReason: null,
        truncated: false,
        summary: [],
        issues: []
      };
    }

    const numberedPatchResult = buildNumberedPatch(file.patch);
    const patchResult = truncateText(numberedPatchResult.numberedPatch, MAX_PATCH_CHARS, "patch");
    const content = file.status === "removed" ? null : await this.githubClient.getFileContent(file.contentsUrl);
    const contextResult = content
      ? buildNumberedContext(content, numberedPatchResult.changedNewLines, 8, MAX_CONTEXT_CHARS)
      : { context: "", truncated: false };

    const truncated = patchResult.truncated || contextResult.truncated;
    const input = this.buildInput(pr, prInfo, file, patchResult.context, contextResult.context, truncated);

    try {
      const draft = await this.modelClient.reviewFile({
        prompt: this.prompt,
        input
      });

      if (process.env.GH_PR_AGENT_DEBUG === "1") {
        process.stderr.write(`review:done ${file.path}\n`);
      }

      return {
        path: file.path,
        previousPath: file.previousPath,
        status: file.status,
        skipped: false,
        skipReason: null,
        reviewFailed: false,
        reviewFailureReason: null,
        truncated,
        summary: draft.summary.map((item) => item.trim()).filter(Boolean),
        issues: draft.issues.map((issue) => ({
          ...issue,
          line:
            issue.line !== null && !numberedPatchResult.validNewLines.has(issue.line) ? null : issue.line,
          title: issue.title.trim(),
          details: issue.details.trim()
        }))
      };
    } catch (error) {
      if (process.env.GH_PR_AGENT_DEBUG === "1") {
        const message = error instanceof Error ? error.message : "Unknown model error";
        process.stderr.write(`review:error ${file.path} ${message}\n`);
      }
      return {
        path: file.path,
        previousPath: file.previousPath,
        status: file.status,
        skipped: false,
        skipReason: null,
        reviewFailed: true,
        reviewFailureReason: error instanceof Error ? error.message : "Unknown model error",
        truncated,
        summary: [],
        issues: []
      };
    }
  }

  private buildInput(
    pr: PullRequestRef,
    prInfo: PullRequestInfo,
    file: ChangedFile,
    numberedPatch: string,
    numberedContext: string,
    truncated: boolean
  ): string {
    const parts = [
      `Repository: ${pr.owner}/${pr.repo}`,
      `Pull request: #${pr.number}`,
      `PR title: ${prInfo.title}`,
      `PR author: ${prInfo.author}`,
      `Base branch: ${prInfo.base}`,
      `Head branch: ${prInfo.head}`,
      `File path: ${file.path}`,
      `Change status: ${file.status}`,
      `Additions: ${file.additions}`,
      `Deletions: ${file.deletions}`,
      `Changes: ${file.changes}`
    ];

    if (file.previousPath) {
      parts.push(`Previous path: ${file.previousPath}`);
    }

    if (truncated) {
      parts.push("Truncated input: true");
    }

    if (prInfo.body.trim()) {
      parts.push("", "PR body:", prInfo.body.trim());
    }

    parts.push("", "Numbered patch:", numberedPatch);

    if (numberedContext) {
      parts.push("", "Current file context:", numberedContext);
    }

    parts.push(
      "",
      'Return JSON with shape: {"summary": string[], "issues": [{"title": string, "severity": "high"|"medium"|"low", "line": number|null, "confidence": "high"|"medium"|"low", "details": string}]}'
    );

    return parts.join("\n");
  }
}
