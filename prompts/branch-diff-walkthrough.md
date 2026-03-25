---
name: branch-diff-walkthrough
description: Explain code changes in the current git branch relative to main with a guided, file-by-file walkthrough. Use when the user wants to understand only the current branch changes, starting from file-level summaries and an ASCII folder structure, then proceeding one file at a time with before/after explanations, a running checklist, and explicit user confirmation before moving to the next file.
---

# Branch Diff Walkthrough

Guide the user through the current branch diff against `main` for understanding, not default defect-hunting. Focus on what changed, why it changed, and how the branch behaves differently.

## Workflow

Follow this sequence strictly:

1. Identify the current branch.
2. Compare the current branch against `main`.
3. Build a file-level overview before explaining any single file.
4. Choose a review order that helps comprehension.
5. Review one file at a time.
6. Stop after each file and wait for explicit user confirmation before continuing.
7. Maintain a visible checklist of review progress in every file-review response.

Do not explain all files in one response unless the user explicitly asks for a bulk summary.

## Diff Scope

Review only changes introduced by the current branch relative to `main`.

Prefer commands equivalent to:

```bash
git branch --show-current
git diff --name-status main...HEAD
git diff --stat main...HEAD
git diff main...HEAD -- <file>
```

Ignore unrelated history and unchanged files.

If `main` is missing locally or repository conventions suggest a different base branch, ask one short clarifying question before doing detailed review.

## First Review Response

In the first substantive review response, provide:

1. Current branch name
2. Review scope statement
3. Changed file list
4. ASCII folder structure covering only changed files
5. High-level explanation of each changed file in a compact table:
   - file path
   - what the file originally does
   - why this branch changed it
   - change type
6. Recommended review order
7. Checklist with all files marked as not started, in progress, or done
8. The detailed review of only the first file

Keep the overview compact. The goal is to orient the user before the per-file walkthrough begins.

## ASCII Folder Structure

Render a compact ASCII tree that includes only changed files and their parent folders.

Example:

```text
src/
├── api/
│   └── schedule.ts
├── components/
│   └── ShiftCard.tsx
└── utils/
    └── time.ts
tests/
└── schedule.test.ts
```

Show the tree even if only one file changed.

## File-Level Overview

Before the deep dive, summarize each changed file in a Markdown table with these columns:

- File
- Original role in the codebase
- Why it changed in this branch
- Change type: feature, refactor, bug fix, cleanup, test, or config/build/tooling

If the original role is uncertain, state that briefly and infer conservatively from nearby code.

## Review Order

Choose an order that improves comprehension rather than raw diff order or alphabetic order.

Prefer this sequence unless the branch clearly suggests another order:

1. shared types, schemas, constants
2. domain logic, services, utilities
3. state management, hooks, controllers
4. UI entry points, pages, components
5. tests
6. config, tooling, generated files

Justify the chosen order in one or two sentences.

## Per-File Review Format

When reviewing a file, use this structure:

### File N: `path/to/file`

Status checklist:
- [x] previous files
- [>] current file
- [ ] remaining files

Purpose:
- Explain what this file did before the branch changes.

Why it changed:
- Explain the intent of the branch's modifications to this file.

Before vs After:
- Show only the important code differences together.
- Prefer short focused snippets or precise paraphrases over large code dumps.
- Explain changes in control flow, data shape, API contract, rendering behavior, or dependency usage.

Detailed walkthrough:
- Explain the diff in a logical order.
- Group related hunks together instead of following raw diff order blindly.
- Call out moved logic, renamed functions, changed conditions, added edge cases, removed branches, and changed dependencies when relevant.

Impact:
- Explain what behavior changed for callers, users, or adjacent files.
- Mention risks, assumptions, or follow-on files when relevant.

Insight:
- Give a concise engineering judgment on whether the change is appropriate.
- Call out any notable issue, weakness, or follow-up adjustment if needed.
- State whether this file looks merge-ready, conditionally merge-ready, or not merge-ready, and why.

End by asking whether to continue to the next file.

## Interaction Rules

After each file review, stop and wait.

Only continue when the user clearly indicates readiness, for example:

- `ok`
- `看懂了`
- `下一個`
- `continue`

If the user asks follow-up questions about the current file, stay on that file until the user explicitly approves moving on.

If the user asks to jump to another file, update the checklist and continue from that file.

## Checklist Rules

Maintain a running checklist in every file-review response.

Use exactly these states:

- `[ ]` not started
- `[>]` in progress
- `[x]` done

Update the checklist as the conversation progresses.

## Explanation Style

Optimize for understanding the branch, but end each file with a concise engineering judgment.

Prefer:

- intent
- architecture
- before/after behavior
- dependency relationships
- data flow
- why the author changed this

Do not switch into exhaustive bug-hunting review mode unless the user explicitly asks for risk analysis, regressions, or code quality findings.

The `Insight` section should stay short and decision-oriented: suitability of the approach, merge confidence, and the most important caveat only.

Keep explanations concrete and tied to the diff.

## Snippet Discipline

Do not paste large code blocks.

Include only the minimal before/after snippets needed to explain the change. Summarize the rest.

## Large Diffs

If many files changed, still start with the full file-level overview and checklist, then review only the first file.

If generated files or lockfiles changed, mention them briefly and usually defer them until the end unless they are central to understanding the branch.
