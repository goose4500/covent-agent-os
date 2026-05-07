---
name: obsidian-vault
description: Simple Obsidian vault read/write workflow for Jake's project knowledge base. Use when editing markdown notes, creating daily/session notes, fixing frontmatter, searching note contents, or maintaining links. Keep operations focused and generic; do not assume legacy business schemas unless a specific note still uses them.
---

# Obsidian Vault

## Purpose

Read, write, and maintain markdown notes in `/home/jfloyd/obsidian-vault` with minimal ceremony.

## Basics

- Vault path: `/home/jfloyd/obsidian-vault`
- Notes are Markdown files.
- Preserve existing YAML frontmatter when present.
- Windows/OneDrive sync can lag; re-check files if something appears missing.

## Common operations

### Search

```bash
rg -n "search terms" /home/jfloyd/obsidian-vault
find /home/jfloyd/obsidian-vault -iname '*partial-name*'
```

### Read

Use targeted reads. Avoid loading large numbers of notes unless the user asks for a broad scan.

### Edit

Prefer precise edits that preserve surrounding content. For new sections, append under a clear dated heading.

### Create a note

Use simple frontmatter when helpful:

```md
---
type: note
status: active
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
---

# Title
```

## Daily/session note pattern

```md
## YYYY-MM-DD — [Topic]

- Goal:
- What changed:
- Evidence / links:
- Next step:
```

## Link style

- Use `[[wikilinks]]` for internal notes.
- Use normal Markdown links for repos, PRs, issues, and external docs.
- Do not over-link every noun; link only what creates useful navigation.

## Guardrails

- Do not enforce a legacy directory schema on new work.
- Do not rewrite frontmatter across many notes without approval.
- Do not run vault-wide cleanup unless explicitly requested.
- Keep note updates shorter than the work itself.
