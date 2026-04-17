# gh-pr-agent

A local CLI and web UI for reviewing GitHub pull requests with AI. It fetches PR context from GitHub, prepares focused review prompts, and can generate summaries, walkthrough commentary, draft inline comments, and review submissions.

## Backends

- OpenCode CLI with GitHub Copilot. Default for the web UI.
- Claude CLI. Default for interactive walkthrough and summary commands unless another backend flag is provided.
- Codex CLI. Available for summary mode with `--use-codex`.
- Azure Foundry. Available with `--use-foundry`.

CLI backends must already be installed and authenticated in your terminal.

## Requirements

- Node.js 22 LTS or 24 LTS
- A GitHub PAT in `GITHUB_TOKEN`
- At least one authenticated AI backend

For `GITHUB_TOKEN`, use a fine-grained PAT with:

- `Contents: Read`
- `Pull Requests: Read`
- `Pull Requests: Write` if you plan to submit review comments

For the default UI backend, install and authenticate OpenCode:

```bash
brew install anomalyco/tap/opencode
opencode auth login   # select GitHub Copilot
opencode models | grep '^github-copilot/'
```

The default OpenCode model is:

```text
github-copilot/claude-sonnet-4.6
```

## Setup

```bash
npm install && npm run build
cp .env.example .env
npm link
```

Then set at least:

```bash
GITHUB_TOKEN=github_pat_...
```

## Usage

### Web UI

Starts a local review UI with split diff, draft inline comments, AI review, chat, and one-click GitHub submission.

```bash
gh-pr-review ui
gh-pr-review ui https://github.com/OWNER/REPO/pull/123
```

The UI defaults to OpenCode CLI with `github-copilot/claude-sonnet-4.6`.

Use another OpenCode model:

```bash
gh-pr-review ui --opencode-model github-copilot/gpt-5.4
```

Use another backend:

```bash
gh-pr-review ui --use-foundry
```

### Quick Summary

Generates a PR summary and can optionally post inline comments to GitHub.

```bash
gh-pr-review summary https://github.com/OWNER/REPO/pull/123
```

Use OpenCode with GitHub Copilot:

```bash
gh-pr-review summary --use-opencode https://github.com/OWNER/REPO/pull/123
gh-pr-review summary --use-opencode --opencode-model github-copilot/gpt-5.4 https://github.com/OWNER/REPO/pull/123
```

Use Codex CLI:

```bash
gh-pr-review summary --use-codex https://github.com/OWNER/REPO/pull/123
```

### Interactive Walkthrough

Steps through each changed file with AI commentary. Responds in Traditional Chinese.

```bash
gh-pr-review https://github.com/OWNER/REPO/pull/123
```

Terminal commands during a session:

```text
next
jump <file>
status
exit
```

Resume a saved session:

```bash
gh-pr-review resume <session-id>
```

Use OpenCode for walkthrough:

```bash
gh-pr-review --use-opencode https://github.com/OWNER/REPO/pull/123
```

Session data is stored under `.gh-pr-agent/sessions/` and pruned automatically with a 30-day window and max 100 sessions.

## Options

| Flag | Description |
|---|---|
| `--use-opencode` | Use OpenCode CLI |
| `--opencode-model <model-id>` | OpenCode model ID. Default: `github-copilot/claude-sonnet-4.6` |
| `--use-codex` | Use Codex CLI. Summary command only |
| `--codex-model <model-id>` | Codex model ID |
| `--use-foundry` | Use Azure Foundry instead of a local CLI |
| `--model <preset>` | Stored model preset label: `haiku` or `sonnet`. Also selects Azure deployment env var |
| `--claude-model <model-id>` | Claude CLI model ID. Default: `claude-sonnet-4-6` |
| `--prompt-file <path>` | Custom prompt file. Walkthrough only |
| `--prompt-for-github-token` | Prompt for GitHub token if `GITHUB_TOKEN` is unset |
| `--prompt-for-azure-key` | Prompt for Azure key if `AZURE_FOUNDRY_API_KEY` is unset |
| `--verbose` | Show detailed progress logs |

## Configuration

Set in `.env`; it is auto-loaded at startup.

| Variable | When required |
|---|---|
| `GITHUB_TOKEN` | Always |
| `AZURE_FOUNDRY_BASE_URL` | Azure Foundry backend only |
| `AZURE_FOUNDRY_API_KEY` | Azure Foundry backend only |
| `AZURE_FOUNDRY_HAIKU_DEPLOYMENT` | Azure Foundry + `--model haiku` |
| `AZURE_FOUNDRY_SONNET_DEPLOYMENT` | Azure Foundry + `--model sonnet` |
| `USE_OPENCODE` | Optional for `npm run dev`. Set to `1` to use OpenCode CLI in the dev API server |
| `OPENCODE_MODEL` | Optional OpenCode model override for `npm run dev` |
| `TOTAL_PATCH_BUDGET` | Optional. Max diff characters sent to AI for PR-wide prompts. Default: `200000` |
| `BATCH_SIZE` | Optional. Files per AI review batch |
| `BATCH_PATCH_BUDGET` | Optional. Max diff characters per AI review batch |

`TOTAL_PATCH_BUDGET` and `BATCH_PATCH_BUDGET` are character budgets, not token budgets. Raising them can reduce truncation on large PRs, but increases prompt size, latency, and model cost.

## Development

```bash
npm run dev       # API server + Vite frontend
npm test          # run tests
npm run typecheck # type-check src and UI
npm run build     # build CLI and UI
```

For dev UI with OpenCode:

```bash
USE_OPENCODE=1 OPENCODE_MODEL=github-copilot/claude-sonnet-4.6 npm run dev
```

## Security Notes

- Do not paste tokens into terminal commands. They can appear in shell history.
- Do not commit `.env`; it is gitignored.
- Prefer fine-grained GitHub PATs with minimum permissions and short expiration.
- OpenCode/Copilot authentication is separate from `GITHUB_TOKEN`. `GITHUB_TOKEN` is still needed for this app to read PRs and submit reviews.
