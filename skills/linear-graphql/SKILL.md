---
name: linear-graphql
description: Recipes and policy for the single generic `linear_graphql` Pi tool. Load this skill whenever you need to read from or write to Linear (issues, comments, projects, cycles, labels, attachments, etc.) — it covers auth, the 200-with-errors convention, mutation safety, the title clamp, and copy-pasteable GraphQL for the four most common operations.
---

# linear-graphql

Single entry point to Linear's GraphQL API. One tool, infinite recipes.

## When to use this skill

Load this skill whenever the user asks you to read or write anything in Linear — search issues, look up a ticket by identifier, file an issue from a Slack thread, drop a comment on an existing issue, inspect a project/cycle/label, etc. The tool itself (`linear_graphql`) is intentionally dumb; this skill carries the operational knowledge, the recipes, and the safety rules.

## Tool reference

- Tool name: `linear_graphql`
- Args: `query` (required GraphQL document), `variables` (optional object), `operationName` (optional string)
- Source: `extensions/linear-graphql.ts`
- Replaces the deprecated trio `linear_search_issues` / `linear_create_issue` / `linear_add_comment`.

## Auth + endpoint

- Endpoint: `https://api.linear.app/graphql` (override with `LINEAR_API_URL` if needed).
- The tool reads `LINEAR_API_KEY` from the bot env. If it's unset, every call returns `isError: true` with a clear reason.
- Header shape gotcha: Linear's personal API keys go in `Authorization: <KEY>` with **NO `Bearer` prefix**. OAuth access tokens use `Bearer <token>`. The tool currently targets API keys; don't try to add `Bearer` yourself.

## The 200-with-errors convention

Linear's GraphQL endpoint almost always responds with HTTP 200, even on failure. Always check `errors[]` in the response, not just the status code. Each error carries `message`, `path`, and `extensions.code`. The `linear_graphql` tool already surfaces an `isError: true` result when `errors[]` is non-empty, but the raw payload lives in `details.errors` so you can read codes and react.

Common `extensions.code` values to recognize:

- `RATELIMITED` — you exceeded 5000 req/hr or 3M complexity pts/hr on the API key. Back off and retry after a delay; do not loop tightly.
- `INVALID_INPUT` — the variables don't match the schema (wrong UUID format, missing required field, bad enum value). Fix the inputs.
- `FORBIDDEN` / `AUTHENTICATION_ERROR` — the API key lacks scope or is wrong. Tell the user; don't retry.

## Mutation safety

Per `docs/adr/0002-linear-is-execution-truth.md`, Linear is execution truth — mutations must be intentional and explicit. The `extensions/linear-mcp-guard.ts` extension inspects the `query` argument of every `linear_graphql` call; if it contains `mutation`, the guard routes the call through the same Slack approval modal used for proxied Linear MCP mutations. In non-interactive contexts the call is blocked outright.

Practical implications:

- Always confirm mutations with the user before issuing them. The guard is a safety net, not a substitute for asking.
- Prefer drafting comment/status bodies, getting user sign-off, then sending.
- One mutation per turn. If you have multiple changes, batch them into a single mutation when possible, or ask for confirmation between turns.

## Defaults from env

Three env vars provide sensible defaults; the model should pass them through as `$variables` rather than hardcoding IDs:

- `LINEAR_TEAM_ID` — default team for searches and `issueCreate`.
- `LINEAR_PROJECT_ID` — default project for `issueCreate`.
- `LINEAR_STATE_ID` — default initial workflow state for `issueCreate`.

These are exposed in `process.env` to the bot but are not auto-injected into your GraphQL — read them off the env section of `apps/pi-mom/index.mjs` (or ask the operator) and pass them explicitly as variables.

## Policy: title clamp

When creating issues, clamp `title` to a single line ≤240 characters. Strip newlines, collapse whitespace, and if needed truncate to 237 chars + `...`. Linear itself accepts longer titles but they render poorly across surfaces.

## Recipes

All recipes use `$variables` — do not interpolate user data directly into the `query` string.

### 1. Search issues

Use the `issues` connection with a `searchableContent` filter (matches title + description). Default to the configured team to avoid cross-team noise.

```graphql
query IssueSearch($filter: IssueFilter!, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      url
      state { name }
      priority
      updatedAt
    }
  }
}
```

Variables:

```json
{
  "filter": {
    "searchableContent": { "contains": "stream rotation" },
    "team": { "id": { "eq": "<LINEAR_TEAM_ID>" } }
  },
  "first": 5
}
```

Drop the `team` clause to search across all teams the API key can see. Prefer search-before-create to avoid duplicates.

### 2. Get issue by human identifier

Linear's `issue(id: ...)` query accepts either a UUID or the human identifier (e.g. `FE-554`). Use this to resolve a Slack mention like "FE-554" into a real UUID and full payload.

```graphql
query IssueLookup($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    url
    state { name }
    priority
    assignee { id name }
    project { id name }
    parent { id identifier }
  }
}
```

Variables:

```json
{ "id": "FE-554" }
```

### 3. Create issue

```graphql
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier title url }
  }
}
```

Variables (fill in title/description, drop optional fields you don't need):

```json
{
  "input": {
    "teamId": "<LINEAR_TEAM_ID>",
    "projectId": "<LINEAR_PROJECT_ID>",
    "stateId": "<LINEAR_STATE_ID>",
    "title": "Single-line title, ≤240 chars",
    "description": "Markdown body: problem, context, proposed solution, acceptance criteria, Slack thread link.",
    "priority": 2
  }
}
```

Priority enum: 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low.

After the mutation, check `data.issueCreate.success === true` and surface `issue.identifier` + `issue.url` to the user. Confirm with the user before calling.

### 4. Add comment on an issue (by issue UUID)

```graphql
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id url body }
  }
}
```

Variables:

```json
{
  "input": {
    "issueId": "<uuid-from-issue-lookup-or-search>",
    "body": "Markdown comment body. Reference the Slack thread/permalink for traceability."
  }
}
```

If you only have a human identifier (e.g. `FE-554`), run recipe 2 first to resolve it to a UUID, then comment. Confirm with the user before calling.

## Future (will iterate)

The following are intentionally out of scope for this pass — we'll layer them in as use cases come up:

- Sub-issues (`parentId` on `IssueCreateInput`, `parent { id }` filters).
- Labels (`labelIds[]` on issues, `issueLabel` CRUD).
- Cycles (`cycleId` on issues, `cycles(filter:)`).
- Workflow state transitions (`stateId` on `IssueUpdateInput`).
- Attachments (`attachmentCreate`, idempotent `attachmentLinkURL`).
- `actor=app` / agent-platform metadata.
- Full filter operator reference (`eq`, `in`, `contains`, `or`, `and`).
- Deprecated-field tracking from the Linear schema.
