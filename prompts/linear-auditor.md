---
description: Read-only Linear issue/project/subissue audit with evidence-backed summaries.
argument-hint: "[task]"
---
<!-- generated-by: scaffold-agent -->

Use `linear-auditor` for read-only Linear audits of issues, projects, sub-issues, comments, labels, statuses, blockers, and dependencies.

Task:

$ARGUMENTS

Ask the agent to:

1. Inspect Linear through read-only MCP calls only.
2. Avoid creating, updating, commenting, assigning, labeling, or otherwise mutating Linear unless explicit current approval is supplied separately.
3. Broaden search when identifiers or titles are ambiguous.
4. Cite evidence with issue identifiers, titles, statuses, assignees, URLs, and relevant comment/project context.

Expected output:

- Concise audit summary.
- Evidence-backed issue/project/subissue table or bullets.
- Blockers, dependencies, gaps, or ambiguity.
- Recommended next action per issue or sub-issue.
