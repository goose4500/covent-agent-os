---
name: obsidian-main
description: Lightweight access to Jake's Obsidian vault for project notes, decisions, research, and implementation context. Use when the user asks to search the vault, read notes, capture a decision, update a project note, find related notes, or connect current repo work to saved knowledge. Keep this generic; do not assume old agency, hosting, observability, or client-ops workflows.
---

# Obsidian Main

## Purpose

Use the vault as a project memory layer without turning every task into a large knowledge-management workflow.

## Vault

```bash
VAULT=/home/jfloyd/obsidian-vault
```

## Default workflow

1. **Clarify intent**
   - Search/read existing notes?
   - Write/update a note?
   - Capture a decision or session summary?

2. **Use the lightest useful lookup**
   ```bash
   rg -n "keyword|phrase" /home/jfloyd/obsidian-vault
   find /home/jfloyd/obsidian-vault -iname '*keyword*'
   ```

3. **Read only relevant files**
   - Prefer targeted reads over broad vault scans.
   - Follow wikilinks only when they clearly matter.

4. **Write concise updates**
   - Preserve existing frontmatter and structure.
   - Add dates for decisions or session logs.
   - Link to the relevant repo, issue, PR, or note when helpful.

5. **Report what changed**
   - Notes read
   - Notes updated
   - Open questions or follow-ups

## When capturing repo work

Use a short structure:

```md
## YYYY-MM-DD — Session / Decision

- Context:
- Change:
- Why:
- Files/PR:
- Next:
```

## Guardrails

- Do not reorganize the vault unless asked.
- Do not create complex taxonomies for simple notes.
- Do not assume old agency/client categories are still current.
- If the user only needs code work, stay in the repo and skip the vault.
