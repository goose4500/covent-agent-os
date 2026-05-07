---
name: whimsical-board-design-optimizer
description: Analyze and visually improve existing Whimsical boards. Use this skill whenever the user asks to analyze, clean up, beautify, polish, optimize, redesign, improve readability, or make a Whimsical workflow/diagram/board more visually appealing, especially when they provide a board name, URL, or vague reference like “that Whimsical board.” This skill should trigger for Whimsical board design review plus safe implementation of basic design fundamentals using Whimsical MCP tools.
---

# Whimsical Board Design Optimizer

Use this skill to turn a rough Whimsical board into a clearer, more visually appealing diagram while preserving the user's meaning.

This skill complements the `whimsical-mcp` skill. If the Whimsical MCP operating manual is available, use it for tool syntax and guardrails. Do not guess Whimsical-specific schemas; use `whimsical_how_to` before complex edits.

## Core promise

When the user names a Whimsical board and asks for analysis, cleanup, beautification, or optimization:

1. Find and inspect the board.
2. Understand what the diagram is trying to communicate.
3. Identify visual and structural issues.
4. Apply safe, basic design improvements directly in Whimsical when the user asks for edits.
5. Verify with a fresh fetch/image and summarize what changed.

## Default workflow

### 1. Resolve the target board

- Connect to Whimsical if needed:
  - `mcp({ connect: "whimsical" })`
- If the user gives a URL or file ID, use that ID directly.
- If the user gives a name/topic, search:
  - `whimsical_search` with `mode: "files"` or `mode: "all"`.
- If multiple plausible boards appear, ask the user to choose unless one is clearly intended from context.

### 2. Fetch before judging or editing

Fetch both semantic details and a visual snapshot:

- `whimsical_fetch` with `detail: "detailed"`, and usually `expand_groups: true`.
- `whimsical_fetch` with `image: true` for visual composition.

Preserve object IDs in your notes because edits depend on IDs.

### 3. Analyze meaning before aesthetics

First infer the board's message:

- What is the start point?
- What is the end/outcome?
- What are the major paths or branches?
- What decision or contrast is being communicated?
- What is the intended recommendation or takeaway?

Then identify design problems:

- Missing or weak title.
- Unclear start/end.
- Inconsistent colors or shapes.
- Branches that are hard to compare.
- Too much text in tiny labels.
- Notes/callouts that overlap or compete with the flow.
- Poor contrast, spacing, or alignment.
- Lack of outcome nodes or success metrics.

### 4. Use a simple design system

Prefer a small, consistent palette and shape language:

| Meaning | Default visual treatment |
| --- | --- |
| Title / header | Large pill or text banner, `whimsy-blue` / indigo |
| Entry/start | Blue ellipse/circle |
| Neutral process steps | Light blue or blue outlined rectangles |
| Primary user intent / key action | Indigo filled rectangle |
| Decision point | Orange diamond |
| Current/friction path | Red/orange labels and orange steps |
| Proposed/recommended path | Green/mint labels and green steps |
| Outcome/success | Green pill |
| Metric or experiment note | Yellow card |
| Recommendation/callout | Green or light neutral card |

Keep the palette meaningful. Do not color randomly just to make the board colorful.

### 5. Improve layout fundamentals

For workflow diagrams, use these defaults unless the existing board strongly suggests another layout:

- Flow left to right.
- Put shared upstream steps on one horizontal line.
- Put comparison branches in parallel lanes:
  - Current/problem path on top.
  - Proposed/recommended path below.
- Keep connectors readable and avoid unnecessary crossings.
- Add end-state nodes when the flow otherwise stops abruptly.
- Place callout cards near, but not on top of, the relevant branch.
- Leave enough whitespace around title, branches, and notes.

If the board is a compound flowchart and layout becomes messy after edits, consider `whimsical_auto_layout`. For manual board objects, edit `x`, `y`, `width`, and `height` deliberately.

### 6. Edit safely

Before editing, decide whether the user asked for:

- **Analysis only** — do not modify the board; provide findings and suggested changes.
- **Optimization / make it prettier / clean it up** — make reasonable visual improvements directly.
- **Major redesign** — briefly explain the intended operation before applying broad changes.

Safe edits usually include:

- Updating colors, shapes, font sizes, and text wrapping.
- Adding a clear title banner.
- Adding or improving branch labels.
- Adding simple callout cards for recommendation, friction, or metrics.
- Adding missing outcome nodes if they are directly implied by the existing flow.
- Repositioning support notes so the main flow is easier to scan.

Avoid unsafe edits:

- Do not change the business meaning without permission.
- Do not invent connectors that are not implied.
- Do not delete user content unless it is duplicate/obsolete because of your cleanup or the user explicitly requested removal.
- Do not over-design: this is a clarity pass, not a decorative art project.

### 7. Verify and report

After editing:

1. Fetch the board again with `image: true`.
2. If needed, fetch details again to confirm object count/connectors.
3. Summarize the improvements in plain language.
4. Include the board URL.

Use a concise final report:

```markdown
Done — I optimized [board title].

Changes made:
- Added/cleaned up title and hierarchy.
- Color-coded [paths/sections].
- Improved spacing/alignment/readability.
- Added callouts for [recommendation/metric/outcome].

Board: [URL]
```

## Lightweight analysis template

When the user asks for analysis before editing, use this structure:

```markdown
## What the board communicates
[One short paragraph]

## Main design issues
- [Issue]
- [Issue]

## Recommended cleanup
- [Change]
- [Change]

## If you want, I can apply this directly
[Brief note about the intended visual system]
```

## Example behavior

User: “Analyze this workflow diagram in Whimsical: Jake”

Good response behavior:

1. Search for `Jake`.
2. Fetch detailed board data and image.
3. Explain the current vs proposed flow.
4. Identify friction and visual improvements.

User: “Now make it more visually appealing”

Good response behavior:

1. Fetch the current board if not already fresh.
2. Apply a simple visual system: title, color-coded paths, clearer branch labels, outcome nodes, callout cards.
3. Fetch image to verify.
4. Report what changed with the board link.

## Quality bar

A successful optimization makes the board easier to understand in five seconds:

- The title says what the diagram is about.
- The viewer can tell where the flow starts and ends.
- Current vs proposed/problem vs solution paths are visually distinct.
- The recommendation is obvious but not cluttered.
- Existing content is preserved unless the user asked for a stronger redesign.
