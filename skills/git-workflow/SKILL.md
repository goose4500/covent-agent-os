---
name: git-workflow
description: Lightweight Git and GitHub workflow for focused product/repo work. Use this skill when creating branches, checking status, reviewing diffs, committing, pushing, opening PRs, or deciding how to keep work on a frontend repository small and safe. Prefer this over old deployment-heavy workflows; do not assume external hosting, observability, or client-service infrastructure unless the user explicitly asks.
---

# Git Workflow

## Purpose

Keep repository work understandable, reversible, and easy to review.

## Default workflow

1. **Identify the repo and branch**
   ```bash
   git status --short --branch
   git remote -v
   ```

2. **Inspect before editing**
   - Read the relevant files.
   - Search with `rg` before making broad assumptions.
   - Avoid touching unrelated files.

3. **Make the smallest useful change**
   - Prefer PR-sized edits.
   - Keep formatting-only changes separate from behavior changes.
   - Do not rewrite working code just because it could be cleaner.

4. **Review the diff**
   ```bash
   git diff --stat
   git diff
   ```

5. **Run available checks**
   Inspect `package.json`, `pyproject.toml`, or repo docs and run the relevant checks when possible.

   For frontend repos, common checks are:
   ```bash
   npm run lint
   npm run typecheck
   npm run test
   npm run build
   ```

6. **Commit only when the user wants a commit**
   ```bash
   git add <files>
   git commit -m "type(scope): short summary"
   ```

7. **Report clearly**
   - Files changed
   - Checks run and results
   - Any checks skipped and why
   - Remaining risks or follow-up suggestions

## Commit message style

Use short conventional commits when possible:

- `fix(ui): correct mobile layout overflow`
- `feat(search): add empty-state copy`
- `refactor(components): simplify card props`
- `chore(deps): update lockfile`

## Guardrails

- Do not force-push, reset, rebase, or delete branches unless the user explicitly asks.
- Do not claim work is complete without checking the diff.
- Do not claim checks passed unless you actually ran them.
- Do not introduce deployment-specific steps unless the repo docs require them.
