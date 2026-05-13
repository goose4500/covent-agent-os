---
name: linear-covent
description: Linear + Covent workflow guidance for Pi. Use this skill whenever the user asks about Linear, Covent/DispoGenius work tracking, issue IDs, tickets, roadmap/project status, sprint/cycle status, wants a Linear comment/status update drafted or posted, or references a Linear issue from Slack. Covers safe read/write posture, issue-driven coding workflow, comment/status formatting, and Linear API best practices (rate limits, GraphQL error shape, 3-minute creation window).
---

# Linear + Covent Workflow

Use this skill whenever the user asks about Linear, Covent/DispoGenius work tracking, issue IDs, tickets, roadmap/project status, sprint/cycle status, or wants a Linear comment/status update drafted or posted.

## Available access

Pi has global Linear MCP access through the `mcp` tool and the global server named `linear`.

- Check status: `mcp({})` or `mcp({ "server": "linear" })`
- Authenticate if needed: tell the user to run `/mcp-auth linear` in interactive Pi
- Search/discover tools first when unsure: `mcp({ "search": "linear issue" })`
- Describe a tool before first use: `mcp({ "describe": "linear_<tool_name>" })`
- Call MCP tools with `args` as a JSON string, not an object.

## Safety rules

- Reads/searches/summaries are safe.
- Before creating, updating, deleting, assigning/delegating, changing state/priority/labels/project/cycle, or posting/editing/deleting comments in Linear, ask for explicit confirmation unless the user just gave that exact instruction.
- Prefer drafting comments/status updates first, then ask before posting.
- Never store Linear tokens or OAuth data in a repo. Never print secrets.
- Do not enumerate the whole workspace. Use filters, issue IDs, team/project scope, and small `first:` limits.
- Avoid polling Linear. Use targeted fetches; if realtime automation is needed, recommend webhooks rather than loops.

## Issue-driven coding workflow

When a user references a Linear issue ID or asks to work from a ticket:

1. Fetch the issue from Linear before planning.
2. Summarize title, team/project, state, assignee/delegate, priority, labels, acceptance criteria, comments, and blockers.
3. Ask one short clarification only if the issue is ambiguous.
4. Create or recommend a branch name using the issue ID and a short slug.
5. Implement locally using repo tools.
6. Run the repo's relevant checks/tests.
7. Draft a Linear update with:
   - What changed
   - Files/areas touched
   - Tests/checks run and results
   - Blockers or follow-ups
   - PR link if available
8. Ask before posting the update or changing status.

## Comment/status style

Use concise Markdown. A good default Linear comment:

```md
Quick update on <ISSUE-ID>:

- Implemented: ...
- Touched: ...
- Verified: ...
- Notes/blockers: ...

Next: ...
```

For handoff comments, include exact local commands run and any caveats.

## Linear API best practices to remember

- Linear uses GraphQL; GraphQL responses can include `errors` even with HTTP 200.
- Linear rate limits authenticated users/apps around 5,000 requests/hour and enforces query complexity limits.
- Use filters/pagination and request only fields needed.
- Changes to issue properties within the first 3 minutes after issue creation may be treated as part of issue creation rather than later activity.
