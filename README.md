# gh-pr-agent

A local CLI and web UI for reviewing GitHub pull requests with AI. Supports Codex CLI, Claude CLI, and Azure Foundry as backends.

## Requirements

- Node.js 22 LTS or 24 LTS
- A GitHub PAT with `Contents: Read` and `Pull Requests: Read` (add `Write` if you plan to post comments) access to the target repository
- At least one AI backend: [Codex CLI](https://github.com/openai/codex) (default), [Claude CLI](https://github.com/anthropics/claude-code), or Azure Foundry. *(If using a CLI backend, ensure it is installed and authenticated in your terminal first).*

## Setup

```bash
npm install && npm run build
cp .env.example .env   # then fill in your secrets
npm link               # makes gh-pr-review available globally
```

## Usage

### Interactive walkthrough

Steps through each changed file with AI commentary. Responds in Traditional Chinese.

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123
```

Terminal commands during a session: `next`, `jump <file>`, `status`, `exit`.

To resume a saved session:

```bash
gh-pr-review resume <session-id>
```

### Quick summary

Non-interactive. Generates a PR summary and optionally posts inline comments to GitHub.

```bash
gh-pr-review summary https://github.com/OWNER/REPO/pull/123
```

### Web UI

Opens a local review UI in the browser — split diff, draft inline comments, AI review, one-click GitHub submission.

```bash
gh-pr-review ui
gh-pr-review ui https://github.com/OWNER/REPO/pull/123
```

Session data is stored under `.gh-pr-agent/sessions/` and pruned automatically (30-day window, max 100 sessions).

## Options

| Flag | Description |
|---|---|
| `--model <preset>` | `haiku` (default) or `sonnet` |
| `--claude-model <model-id>` | Claude model ID when using Claude CLI (default: `claude-sonnet-4-6`) |
| `--use-foundry` | Use Azure Foundry instead of local CLI |
| `--prompt-file <path>` | Custom prompt file (walkthrough only) |
| `--prompt-for-github-token` | Prompt for GitHub token if env var is unset |
| `--prompt-for-azure-key` | Prompt for Azure key if env var is unset |
| `--verbose` | Show detailed progress logs |

## Configuration

Set in `.env` (auto-loaded at startup):

| Variable | When required |
|---|---|
| `GITHUB_TOKEN` | Always |
| `AZURE_FOUNDRY_BASE_URL` | Azure Foundry backend only |
| `AZURE_FOUNDRY_API_KEY` | Azure Foundry backend only |
| `AZURE_FOUNDRY_HAIKU_DEPLOYMENT` | Azure Foundry + haiku model |
| `AZURE_FOUNDRY_SONNET_DEPLOYMENT` | Azure Foundry + sonnet model |
| `TOTAL_PATCH_BUDGET` | Optional. Max diff characters sent to AI for PR-wide review/summary prompts. Default: `200000` |

`TOTAL_PATCH_BUDGET` is a character budget, not a token budget. Raising it can reduce prompt truncation on large PRs, but increases prompt size, latency, and model cost.

## Development

```bash
npm run dev       # API server + Vite frontend (hot reload)
npm test          # run tests
npm run typecheck # type-check src and UI
```

## Security Notes

- Do not paste tokens into terminal commands — they appear in shell history.
- Do not commit `.env` to the repository (it is gitignored).
- Prefer fine-grained GitHub PATs with minimum permissions and short expiration.
