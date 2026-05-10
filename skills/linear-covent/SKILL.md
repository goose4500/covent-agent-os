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

## Internal automation: use `@covent/linear-client`

The guidance above covers **interactive, human-driven** Linear work in Pi — Pi reaches Linear through the global `linear` MCP server and the `linear_*` tools (read, search, draft, then ask before mutating).

When you are reasoning about **automated** flows that originate inside the Covent Agent OS — `apps/pi-mom`'s Slack → Linear route, the `/webhooks/linear` receiver, or any new workflow node / PI agent the team launches — the canonical surface is the typed library `@covent/linear-client` (`packages/linear-client/`), not the MCP server. Key points to keep in mind when authoring or reviewing automation:

- All internal Linear calls go through `createLinearClient({ apiKey })`. No caller should reach into `@linear/sdk` directly, hand-roll GraphQL, or call MCP tools from a server-side automation path.
- Slack-triggered issue creation uses `client.issues.upsertFromSlack(...)`, which is idempotent on the Slack permalink: re-running the same route on the same thread returns the existing issue rather than duplicating it.
- Lookup helpers accept both UUIDs and human identifiers (`client.issues.find("FE-123")` and `client.issues.find("<uuid>")` both work).
- Workflow-state transitions resolve by name+team via a per-team cache (`client.issues.transition(id, { stateName: "In Progress" })`), not by hardcoded state IDs.
- Inbound webhooks are verified via `client.webhooks.verify(...)` — HMAC-SHA256 over the raw body, 60s replay window, two-secret rotation pattern.

Authoritative reading order: `docs/source-of-truth/LINEAR_INTEGRATION_PRD.md`, then `docs/specs/linear-client-spec.md`, then ADRs `docs/adr/0005-linear-client-library.md` and `docs/adr/0006-linear-webhooks-colocated-with-pi-mom.md`, plus the runbook `docs/runbooks/linear-webhook-setup.md`. The MCP-based interactive guidance above remains the right answer for "what does Pi do when a human asks it to look something up in Linear".
