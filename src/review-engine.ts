import { ChangedFile, FileReview, PullRequestInfo, PullRequestRef, ReviewReport } from "./types.js";
import { buildNumberedContext, buildNumberedPatch, truncateText } from "./diff-line-mapper.js";
import { GitHubClient } from "./github-client.js";
import { ModelClient } from "./model-client.js";

const MAX_PATCH_CHARS = 8000;
const MAX_CONTEXT_CHARS = 4000;
const MODEL_HEARTBEAT_MS = 10000;

interface ReviewEngineOptions {
  onProgress?: (message: string) => void;
  verbose?: boolean;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
}

export class ReviewEngine {
  private readonly onProgress: ((message: string) => void) | undefined;
  private readonly verbose: boolean;

  constructor(
    private readonly githubClient: GitHubClient,
    private readonly modelClient: ModelClient,
    private readonly prompt: string,
    options: ReviewEngineOptions = {}
  ) {
    this.onProgress = options.onProgress;
    this.verbose = options.verbose ?? false;
  }

  async reviewPullRequest(pr: PullRequestRef): Promise<ReviewReport> {
    const startedAt = Date.now();
    this.emit("Fetching PR metadata...");
    const prInfo = await this.githubClient.getPullRequest(pr);
    this.emit(`Loaded PR #${pr.number}: ${prInfo.title}`);
    this.emit("Fetching changed files...");
    const files = await this.githubClient.listPullRequestFiles(pr);
    this.emit(`Found ${files.length} changed file(s).`);
    const reviews: FileReview[] = [];

    for (const [index, file] of files.entries()) {
      reviews.push(await this.reviewFile(pr, prInfo, file, index + 1, files.length));
    }

    this.emit(
      `Completed review in ${formatDuration(Date.now() - startedAt)}.`
    );

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
    file: ChangedFile,
    fileIndex: number,
    totalFiles: number
  ): Promise<FileReview> {
    const startedAt = Date.now();
    const prefix = `[${fileIndex}/${totalFiles}]`;

    if (process.env.GH_PR_AGENT_DEBUG === "1") {
      process.stderr.write(`review:start ${file.path}\n`);
    }

    this.emit(`${prefix} Reviewing ${file.path}...`);

    if (!file.patch) {
      this.emit(`${prefix} Skipped ${file.path} in ${formatDuration(Date.now() - startedAt)}.`);
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
    this.emitVerbose(`${prefix} Loading file context for ${file.path}.`);
    const content = file.status === "removed" ? null : await this.githubClient.getFileContent(file.contentsUrl);
    const contextResult = content
      ? buildNumberedContext(content, numberedPatchResult.changedNewLines, 8, MAX_CONTEXT_CHARS)
      : { context: "", truncated: false };

    const truncated = patchResult.truncated || contextResult.truncated;
    if (truncated) {
      this.emitVerbose(`${prefix} Truncated review payload for ${file.path}.`);
    }
    const input = this.buildInput(pr, prInfo, file, patchResult.context, contextResult.context, truncated);

    try {
      const heartbeat = setInterval(() => {
        this.emit(
          `${prefix} Still reviewing ${file.path}... ${formatDuration(Date.now() - startedAt)} elapsed.`
        );
      }, MODEL_HEARTBEAT_MS);

      const draft = await this.modelClient.reviewFile({
        prompt: this.prompt,
        input
      }).finally(() => clearInterval(heartbeat));

      if (process.env.GH_PR_AGENT_DEBUG === "1") {
        process.stderr.write(`review:done ${file.path}\n`);
      }

      this.emit(
        `${prefix} Done ${file.path} in ${formatDuration(Date.now() - startedAt)} (${draft.issues.length} issue(s)).`
      );

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
      const message = error instanceof Error ? error.message : "Unknown model error";
      this.emit(`${prefix} Failed ${file.path} in ${formatDuration(Date.now() - startedAt)}: ${message}`);
      return {
        path: file.path,
        previousPath: file.previousPath,
        status: file.status,
        skipped: false,
        skipReason: null,
        reviewFailed: true,
        reviewFailureReason: message,
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

  private emit(message: string): void {
    this.onProgress?.(message);
  }

  private emitVerbose(message: string): void {
    if (this.verbose) {
      this.onProgress?.(message);
    }
  }
}
