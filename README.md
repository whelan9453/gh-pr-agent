# gh-pr-agent

`gh-pr-agent` is a local CLI for reviewing GitHub pull requests with Claude on Azure Foundry.

## Features

- Review private GitHub PRs with GitHub PATs
- Use Azure Foundry Claude deployments
- Generate per-file change highlights and possible issues with line numbers
- Save structured JSON output for future GitHub comment automation
- Store secrets in macOS Keychain instead of repo files

## Requirements

- Node.js 20+
- A GitHub PAT with access to the target private repository
- An Azure Foundry resource with a Claude deployment

## Setup

```bash
cd /Users/whelan/repo/gh-pr-agent
npm install
npm run build
```

## Credential Management

Recommended local setup on macOS:

```bash
gh-pr-review auth login
```

This stores:

- `GITHUB_TOKEN` in macOS Keychain
- `AZURE_FOUNDRY_API_KEY` in macOS Keychain
- non-secret defaults such as base URL and deployment names in your local user config

Inspect stored status:

```bash
gh-pr-review auth status
```

Remove stored secrets:

```bash
gh-pr-review auth logout
```

Remove secrets and local defaults:

```bash
gh-pr-review auth logout --all
```

Runtime resolution order:

1. Environment variables
2. Stored local config and macOS Keychain
3. Hidden prompt flags

## Configuration

Required:

- `AZURE_FOUNDRY_BASE_URL`
- `AZURE_FOUNDRY_HAIKU_DEPLOYMENT`

Optional:

- `GITHUB_TOKEN`
- `AZURE_FOUNDRY_API_KEY`
- `AZURE_FOUNDRY_SONNET_DEPLOYMENT`
- `GH_PR_AGENT_DEFAULT_MODEL`
- `PR_REVIEW_PROMPT_FILE`

`AZURE_FOUNDRY_BASE_URL` should look like:

```text
https://<resource>.services.ai.azure.com/anthropic
```

## Usage

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123
```

Prompt for hidden secrets when nothing is stored:

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123 --prompt-for-github-token --prompt-for-azure-key
```

Choose a different deployment preset:

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123 --model haiku
```

Write JSON output:

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123 --json-output review-output/pr-123.json
```

Use a custom review prompt:

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123 --prompt-file /absolute/path/to/review_prompt.md
```

## Security Notes

- Do not paste PATs or API keys into terminal commands. They end up in shell history and process lists.
- Do not commit `.env` files or plaintext tokens to the repository.
- Rotate leaked credentials immediately.
- Prefer fine-grained GitHub PATs with minimum repo permissions and short expiration.
- For production or shared deployments, prefer Microsoft Entra ID or a central secret manager such as Azure Key Vault.
