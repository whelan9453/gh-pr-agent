import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";

import { ChangedFile, PullRequestInfo, PullRequestRef } from "./types.js";

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
