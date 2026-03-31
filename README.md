# gh-pr-agent

A local CLI and web UI for reviewing GitHub pull requests with AI. Supports Claude CLI, Codex CLI, and Azure Foundry as backends.

## Features

- **Interactive walkthrough** — step through each changed file with AI commentary in your terminal
- **Quick summary** — surface major issues in a PR without a full walkthrough
- **Web UI** — split diff view with draft inline comments, review summary, and one-click GitHub submission
- **Multiple AI backends** — Codex CLI (default), Claude CLI, or Azure Foundry
- Works with private repos via GitHub PAT

## Requirements

- Node.js 22 LTS or 24 LTS
- A GitHub PAT with read access to the target repository
- At least one AI backend:
  - [Codex CLI](https://github.com/openai/codex) (default)
  - [Claude CLI](https://github.com/anthropics/claude-code)
  - Azure Foundry with a Claude deployment

## Setup

```bash
npm install
npm run build
```

Copy the example env file and fill in your secrets:

```bash
cp .env.example .env
```

Then run directly:

```bash
node dist/src/cli.js <pr-url>
```

Or link globally for a shorter command:

```bash
npm link
gh-pr-review <pr-url>
```

## Configuration

Set these in `.env` (the CLI auto-loads it at startup):

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | GitHub PAT with repo read access |
| `AZURE_FOUNDRY_BASE_URL` | Azure only | e.g. `https://<resource>.services.ai.azure.com/anthropic` |
| `AZURE_FOUNDRY_API_KEY` | Azure only | Azure Foundry API key |
| `AZURE_FOUNDRY_HAIKU_DEPLOYMENT` | Azure only | Deployment name for haiku model |
| `AZURE_FOUNDRY_SONNET_DEPLOYMENT` | Azure only | Deployment name for sonnet model |

## Commands

### `gh-pr-review <pr-url>` — interactive walkthrough (default)

Steps through each changed file one by one. Responds in Traditional Chinese by default.

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123
```

Navigate with:
- `next` / `ok` / `continue` — move to next file
- `jump <file-path>` — jump to a specific file
- `status` — show current position
- `exit` — save and quit

### `gh-pr-review walkthrough <pr-url>`

Same as the default command, with explicit subcommand syntax.

```bash
gh-pr-review walkthrough https://github.com/OWNER/REPO/pull/123 --model sonnet
```

### `gh-pr-review resume <session-id>`

Resume a previously saved walkthrough session.

```bash
gh-pr-review resume m1a2b3-xyz456
```

### `gh-pr-review summary <pr-url>`

Non-interactive mode. Generates a PR summary and optionally posts inline comments to GitHub.

```bash
gh-pr-review summary https://github.com/OWNER/REPO/pull/123
```

After the summary, available commands: `post`, `approve`, `exit`.

### `gh-pr-review ui [pr-url]`

Opens the local web UI in your browser. Supports split diff, draft comments, AI review, and GitHub review submission.

```bash
gh-pr-review ui
gh-pr-review ui https://github.com/OWNER/REPO/pull/123
```

Session data is cached under `.gh-pr-agent/sessions/` and pruned automatically (30-day window, max 100 sessions).

## Options

All commands accept:

| Flag | Description |
|---|---|
| `--model <preset>` | `haiku` (default) or `sonnet` |
| `--use-foundry` | Use Azure Foundry instead of local CLI |
| `--claude-model <model-id>` | Claude model ID for Claude CLI backend (default: `claude-sonnet-4-6`) |
| `--prompt-file <path>` | Path to a custom prompt file (walkthrough only) |
| `--prompt-for-github-token` | Prompt for GitHub token if env var is unset |
| `--prompt-for-azure-key` | Prompt for Azure key if env var is unset |
| `--verbose` | Show detailed progress logs |

## Development

```bash
npm run dev       # start API server + Vite frontend dev server
npm test          # run tests
npm run typecheck # type-check src and UI
```

## Security Notes

- Do not paste tokens into terminal commands — they appear in shell history and process lists.
- Do not commit `.env` to the repository (it is gitignored).
- Rotate leaked credentials immediately.
- Prefer fine-grained GitHub PATs with minimum permissions and short expiration.
- For shared deployments, use Microsoft Entra ID or a secret manager such as Azure Key Vault.
