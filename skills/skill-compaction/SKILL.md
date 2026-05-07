---
name: skill-compaction
description: Use this skill whenever the user wants to combine, pack, merge, compress, or summarize multiple existing skills into one lightweight router skill/folder. The user may name skills, describe desired cognitive modes, or ask for a "one SKILL.md" bundle under ~50 lines.
---

# Skill Compaction

Create tiny meta-skills that pack several existing skills into one barebones `SKILL.md`.

## Workflow

1. Parse the user's requested source skills/modes and desired new skill name.
2. Locate matching skills from `available_skills`; preserve exact skill names.
3. If behavior details matter, read the source `SKILL.md` files; otherwise use names/descriptions.
4. Extract only durable fundamentals: trigger context, core behavior, and routing/default combo.
5. Write one simple skill folder with a single `SKILL.md`; avoid bundled resources unless requested.
6. Keep it under ~50 lines when possible; prefer bullets over prose.
7. Do not clone full source instructions; make a router/cheat-sheet that invokes the right mode.
8. Verify with `wc -l` and show the final path.

## Compact skill template

```md
---
name: new-skill-name
description: Use when the user wants [combined intent]. This routes across [source skills].
---

# Human Title

Use this as a lightweight router. Pick the smallest useful combo.

## Modes
- `skill-a`: one-line fundamental.
- `skill-b`: one-line fundamental.

## Default combo
1. Start with the broad framing mode.
2. Add critique/systems/debug/product modes only when useful.

Return concise synthesis, not process theater.
```
