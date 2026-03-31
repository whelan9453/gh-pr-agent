# gh-pr-agent

`gh-pr-agent` is a local CLI for reviewing GitHub pull requests with Claude, Codex CLI, or Azure Foundry.

## Features

- Review private GitHub PRs with GitHub PATs
- Use local Claude CLI or Codex CLI from the AI Review panel, with Codex CLI as the default
- Use Azure Foundry Claude deployments
- Generate per-file change highlights and possible issues with line numbers
- Save structured JSON output for future GitHub comment automation
- Open a local PR review web UI with split diff, draft comments, and GitHub review submission

## Requirements

- Node.js 22 LTS or 24 LTS
- A GitHub PAT with access to the target private repository
- An Azure Foundry resource with a Claude deployment

## Setup

```bash
cd /Users/whelan/repo/gh-pr-agent
npm run setup-local
```

After that, you can run:

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123
```

The CLI prints progress updates to `stderr` while the final review stays on `stdout`.

For contributors who do not want a global command on `PATH`, the manual flow is:

```bash
npm install
npm run build
node dist/src/cli.js https://github.com/OWNER/REPO/pull/123
```

Useful local scripts:

```bash
npm run ui       # build + launch the local web UI
npm run dev:cli  # run the CLI directly from source
npm run dev:ui   # run the frontend dev server only
```

For local use, the fastest setup is:

```bash
cp .env.example .env
```

Then paste your local secrets into `.env`. The file is gitignored.

## Configuration

Required:

- `GITHUB_TOKEN`
- `AZURE_FOUNDRY_BASE_URL`
- `AZURE_FOUNDRY_API_KEY`
- `AZURE_FOUNDRY_HAIKU_DEPLOYMENT` or `AZURE_FOUNDRY_SONNET_DEPLOYMENT`

Optional:

- `PR_REVIEW_PROMPT_FILE`

The CLI auto-loads `.env` at startup.

`AZURE_FOUNDRY_BASE_URL` should look like:

```text
https://<resource>.services.ai.azure.com/anthropic
```

## Usage

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123
```

Prompt for hidden secrets when env vars are unset:

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123 --prompt-for-github-token --prompt-for-azure-key
```

Choose a different deployment preset:

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123 --model haiku
gh-pr-review https://github.com/OWNER/REPO/pull/123 --model sonnet
```

Launch the local review UI:

```bash
gh-pr-review ui
```

Or open the UI with a PR URL prefilled:

```bash
gh-pr-review ui https://github.com/OWNER/REPO/pull/123
```

The UI opens in your browser, caches PR review data under `.gh-pr-agent/sessions`, lets you create local draft comments on diff ranges, and posts the final review back to GitHub in one submission. Stored sessions are pruned automatically to keep only the most recent 30 days and at most 100 sessions.

Write JSON output:

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123 --json-output review-output/pr-123.json
```

Show more detailed progress logs:

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123 --verbose
```

Use a custom review prompt:

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123 --prompt-file /absolute/path/to/review_prompt.md
```

The built-in default prompt is [`prompts/branch-diff-walkthrough.md`](/Users/whelan/repo/gh-pr-agent/prompts/branch-diff-walkthrough.md).

## Security Notes

- Do not paste PATs or API keys into terminal commands. They end up in shell history and process lists.
- Do not commit `.env` files or plaintext tokens to the repository.
- Rotate leaked credentials immediately.
- Prefer fine-grained GitHub PATs with minimum repo permissions and short expiration.
- For production or shared deployments, prefer Microsoft Entra ID or a central secret manager such as Azure Key Vault.
