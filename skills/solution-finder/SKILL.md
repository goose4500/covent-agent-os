---
name: solution-finder
description: Search Jake's prior notes and code for reusable patterns before rebuilding something. Use when the user asks whether they have solved something before, wants prior art, asks for a reusable implementation pattern, or wants to avoid reinventing a workflow. Keep the search lightweight and project-agnostic; do not assume legacy client work is relevant.
---

# Solution Finder

## Purpose

Find useful prior work quickly, then summarize what can be reused for the current task.

## Search locations

Start with:

```bash
VAULT=/home/jfloyd/obsidian-vault
HOME=/home/jfloyd
```

Useful places:

- `/home/jfloyd/obsidian-vault`
- `/home/jfloyd` project directories
- current repo history and source files

## Default workflow

1. **Extract 3-5 concrete search terms**
   Prefer product names, API names, component names, error strings, and action verbs.

2. **Search notes**
   ```bash
   rg -n "term1|term2|term3" /home/jfloyd/obsidian-vault
   ```

3. **Search code if relevant**
   ```bash
   rg -n "term1|term2|term3" /home/jfloyd --glob '!node_modules' --glob '!.git'
   ```

4. **Read the top matches**
   Validate relevance from context instead of trusting filenames alone.

5. **Return a ranked list**
   For each match, include:
   - Path
   - Why it matters
   - What can be reused
   - Any caveats

## Output format

```md
## Prior art found

1. `path/to/file`
   - Relevance:
   - Reusable pattern:
   - Caveat:

## Recommended reuse

- Do this:
- Avoid this:
- Next file to inspect:
```

## Guardrails

- Do not present weak matches as proven solutions.
- Do not turn a quick prior-art search into a full vault synthesis.
- Do not assume old client/business context is still the target.
- If no good prior art exists, say so and suggest a simple next step.
