import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";

import {
  ChangedFile,
  PullRequestInfo,
  PullRequestRef,
  PrIssueComment,
  PrReview,
  PrReviewComment,
  ReviewCommentSide
} from "../types.js";

const PR_URL_RE =
  /^https:\/\/(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<number>\d+)(?:\/.*)?$/;

export function parsePullRequestUrl(url: string): PullRequestRef {
  const match = PR_URL_RE.exec(url.trim());
  if (!match?.groups) {
    throw new Error(`Unsupported pull request URL: ${url}`);
  }

  const host = match.groups.host ?? "";
  const owner = match.groups.owner ?? "";
  const rawRepo = match.groups.repo ?? "";
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  const number = Number(match.groups.number ?? "0");
  const apiBaseUrl = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;

  return {
    host,
    owner,
    repo,
    number,
    url: `https://${host}/${owner}/${repo}/pull/${number}`,
    apiBaseUrl
  };
}

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string, baseUrl?: string) {
    const options: ConstructorParameters<typeof Octokit>[0] = { auth: token };
    if (baseUrl) {
      options.baseUrl = baseUrl;
    }
    options.request = {
      fetch: fetch as unknown as typeof globalThis.fetch
    };
    this.octokit = new Octokit(options);
  }

  async getPullRequest(pr: PullRequestRef): Promise<PullRequestInfo> {
    const response = await this.octokit.pulls.get({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number
    });

    return {
      title: response.data.title ?? "",
      body: response.data.body ?? "",
      state: response.data.state ?? "",
      author: response.data.user?.login ?? "",
      base: response.data.base.ref,
      baseSha: response.data.base.sha,
      head: response.data.head.ref,
      headSha: response.data.head.sha,
      additions: response.data.additions ?? 0,
      deletions: response.data.deletions ?? 0,
      changedFiles: response.data.changed_files ?? 0
    };
  }

  async listPullRequestFiles(pr: PullRequestRef): Promise<ChangedFile[]> {
    const files = await this.octokit.paginate(this.octokit.pulls.listFiles, {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: 100
    });

    return files.map((file) => ({
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: "patch" in file ? file.patch ?? null : null,
      contentsUrl: file.contents_url ?? null,
      blobUrl: file.blob_url ?? null
    }));
  }

  async listIssueComments(pr: PullRequestRef): Promise<PrIssueComment[]> {
    const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.number,
      per_page: 100
    });
    return comments.map((c) => ({
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.created_at
    }));
  }

  async listReviews(pr: PullRequestRef): Promise<PrReview[]> {
    const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: 100
    });
    return reviews.map((r) => ({
      author: r.user?.login ?? "unknown",
      state: r.state,
      body: r.body ?? "",
      submittedAt: r.submitted_at ?? ""
    }));
  }

  async listReviewComments(pr: PullRequestRef): Promise<PrReviewComment[]> {
    const comments = await this.octokit.paginate(this.octokit.pulls.listReviewComments, {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: 100
    });
    return comments.map((c) => ({
      id: c.id,
      author: c.user?.login ?? "unknown",
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      side: normalizeReviewCommentSide(c.side),
      startLine: c.start_line ?? c.original_start_line ?? null,
      startSide: normalizeReviewCommentSide(c.start_side),
      replyToId: c.in_reply_to_id ?? null,
      body: c.body,
      createdAt: c.created_at
    }));
  }

  async createReview(
    pr: PullRequestRef,
    commitId: string,
    body: string,
    inlineComments: Array<{
      path: string;
      line: number;
      side: ReviewCommentSide;
      body: string;
      startLine?: number | null;
      startSide?: ReviewCommentSide | null;
    }>,
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" = "COMMENT"
  ): Promise<string> {
    const response = await this.octokit.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      commit_id: commitId,
      event,
      body,
      comments: inlineComments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side,
        body: c.body,
        ...(c.startLine ? { start_line: c.startLine } : {}),
        ...(c.startSide ? { start_side: c.startSide } : {})
      }))
    });
    return response.data.html_url ?? pr.url;
  }

  async getRepoFileContent(
    pr: PullRequestRef,
    filePath: string,
    ref: string
  ): Promise<string | null> {
    try {
      const response = await this.octokit.repos.getContent({
        owner: pr.owner,
        repo: pr.repo,
        path: filePath,
        ref
      });
      const payload = response.data;
      if (Array.isArray(payload)) {
        return null;
      }
      if (payload.type !== "file" || !payload.content || payload.encoding !== "base64") {
        return null;
      }
      return Buffer.from(payload.content, "base64").toString("utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getFileContent(contentsUrl: string | null): Promise<string | null> {
    if (!contentsUrl) {
      return null;
    }

    const response = await this.octokit.request(`GET ${contentsUrl}`);
    const payload = response.data as {
      type?: string;
      content?: string;
      encoding?: string;
    };

    if (payload.type !== "file" || !payload.content || payload.encoding !== "base64") {
      return null;
    }

    return Buffer.from(payload.content, "base64").toString("utf8");
  }
}

function normalizeReviewCommentSide(raw: string | null | undefined): ReviewCommentSide | null {
  if (raw === "LEFT" || raw === "RIGHT") {
    return raw;
  }
  return null;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}
