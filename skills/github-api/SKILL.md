---
name: github-api
description: Fundamentals for calling GitHub via the in-process `github_api` Pi tool. One tool, two surfaces (REST + GraphQL), routed by the `path` arg — mirrors the mental model of the `gh api` CLI. Use this skill whenever the user asks Pi to read PRs, issues, checks, branches, files, commits, releases, Actions runs, or anything on github.com; whenever Pi needs to comment on / label / assign / merge an issue or PR; or when Pi needs to stitch together PR state (status checks + reviews + files) in one shot via GraphQL. Default to REST; reach for GraphQL only for Projects v2, multi-resource stitched queries, advanced issue search, and sub-issues.
---

# GitHub API tool — fundamentals

Pi has a single in-process tool for GitHub: **`github_api`**. It is the only correct way to talk to GitHub from a Pi run.

There is no MCP server, no `gh` shell-out, no per-endpoint wrapper. One tool, two surfaces:

- **REST** — pass a resource path like `/repos/{owner}/{repo}/pulls/123`.
- **GraphQL** — pass `path: "graphql"` (or `/graphql`) and a `body` of `{query, variables?}`.

The routing rule is simple: **if `path === "graphql"` or `path === "/graphql"`, the call goes to the GraphQL endpoint; otherwise it goes to REST.** This mirrors the `gh api` CLI, which the model already knows.

## Auth + endpoint

- REST base: `https://api.github.com`
- GraphQL: `https://api.github.com/graphql`
- Auth: `Authorization: Bearer $GITHUB_TOKEN` (added automatically)
- Enterprise: set `GITHUB_API_URL` to override the base (e.g. `https://github.your-corp.com/api/v3`).

GitHub tokens are **opaque**. Do not parse or length-check them — the token format is mid-rollout May–June 2026 and the byte length is growing. If `GITHUB_TOKEN` is unset the tool returns `isError`.

## Standard headers (automatic)

Every call gets these set for you. Override any of them by passing the same key in the `headers` arg (caller wins):

- `Authorization: Bearer <GITHUB_TOKEN>`
- `Accept: application/vnd.github+json`
- `X-GitHub-Api-Version: 2022-11-28`
- `Content-Type: application/json` (only added when `body` is present)

Use `headers` to opt into feature flags. The most common one today is sub-issues:

```json
{ "headers": { "GraphQL-Features": "sub_issues" } }
```

## Two response conventions

This is the single biggest source of bugs. Internalise the difference:

- **REST**: a non-2xx HTTP status is a failure. The tool sets `isError: true` and preserves the parsed body in `details.body`.
- **GraphQL**: the HTTP status is almost always 200, even on a "failed" query. Check `details.errors` — a non-empty `errors[]` is a failure, even if `details.data` is partially populated. The tool surfaces both `data` and `errors` verbatim so you can read partial data.

## Mutation safety

The tool classifies a call as a mutation when:

- REST and method is `POST`, `PATCH`, `PUT`, or `DELETE`, **or**
- GraphQL and the query string matches `/\bmutation\b/i`.

This is exposed as `details.mutation: true` on the result. A sibling guard extension can read this on the `tool_call` event to require a user confirmation (same shape as `extensions/linear-mcp-guard.ts`). The `github_api` tool itself is intentionally dumb — it never prompts. Expect writes to be denied or prompted in non-interactive surfaces depending on project policy.

When you are about to mutate something, say so in the user-facing text **before** the tool call, so the prompt makes sense if a guard pops a confirmation modal.

## Rate-limit etiquette

- Authenticated REST: 5000 requests/hour per token. GraphQL counts against the same hourly budget but is point-weighted.
- **Secondary rate limits** apply on bursty writes and concurrent requests. These return HTTP `403` or `429` with a `Retry-After` header. The tool surfaces both the status and `Retry-After` in the error message so the model can decide whether to back off or hand control back to the user.
- Never poll in a tight loop. If a user wants "live" status, recommend webhooks rather than polling.

## When REST, when GraphQL

**Default to REST.** It is the larger surface, the simpler mental model, and the docs are easier to navigate.

Reach for GraphQL only when:

- **Projects v2** — there is no REST equivalent for Projects v2 reads or writes.
- **Multi-resource stitched queries** — when you want a PR's title, mergeability, last commit's check-runs, last N reviews, and changed files in **one** round trip. Doing this over REST is 4+ calls and a chunk of glue.
- **Advanced issue search** — the GraphQL `search` connection supports richer filters.
- **Sub-issues** — opt-in via `headers: { "GraphQL-Features": "sub_issues" }`.

If you find yourself doing >3 REST calls to assemble one answer, switch to GraphQL.

---

## Recipes

The five recipes below are copy-pasteable JSON payloads — i.e. the literal arg object you hand to `github_api`. They are deliberately concrete: `owner`/`repo`/`n` are placeholders the model fills in from the user's request.

### 1. Read a PR (REST)

```json
{
  "method": "GET",
  "path": "/repos/{owner}/{repo}/pulls/{n}"
}
```

Returns the PR object: title, state, head/base, draft, mergeable, merge_commit_sha, requested_reviewers, etc. Does **not** include check runs or review approvals (those need separate calls — or one GraphQL query, see recipe 4).

### 2. List open PRs (REST)

```json
{
  "method": "GET",
  "path": "/repos/{owner}/{repo}/pulls?state=open&per_page=30"
}
```

`state` is one of `open|closed|all`. Add `&sort=updated&direction=desc` for "most recently touched". This recipe does not paginate — the tool returns one page only. For >30 PRs, increment `&page=2` (the tool does not auto-page).

### 3. Comment on an issue or PR (REST)

Issues and PRs share the same comment endpoint — `/issues/{n}/comments` works for either:

```json
{
  "method": "POST",
  "path": "/repos/{owner}/{repo}/issues/{n}/comments",
  "body": { "body": "Hi from Pi — see thread <slack-link> for context." }
}
```

This is classified as a mutation (`details.mutation: true`). Expect the guard layer to prompt.

### 4. "Give me everything about a PR" — stitched GraphQL ★

This is the canonical recipe when the user asks "what's the state of PR #N" and wants reviews + checks + files in one go.

```json
{
  "path": "graphql",
  "body": {
    "query": "query PRSnapshot($owner: String!, $repo: String!, $n: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $n) { number title state isDraft mergeStateStatus mergeable url author { login } commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 50) { nodes { __typename ... on CheckRun { name conclusion status detailsUrl } ... on StatusContext { context state targetUrl } } } } } } } reviews(last: 20) { nodes { author { login } state submittedAt body } } files(first: 50) { nodes { path additions deletions } } } } }",
    "variables": { "owner": "{owner}", "repo": "{repo}", "n": 123 }
  }
}
```

Single round trip; returns one consolidated `data.repository.pullRequest` object. Check `details.errors` even though the HTTP status is 200.

### 5. Check runs for a commit SHA (REST)

```json
{
  "method": "GET",
  "path": "/repos/{owner}/{repo}/commits/{sha}/check-runs"
}
```

Useful when the user is debugging a specific commit ("why is sha abc123 red?") without needing the whole PR context. For PR-level stitched check state, prefer recipe 4.

---

## Token note

GitHub tokens are opaque strings. Do not parse, prefix-check, or length-check them. The tool does redact obvious token-like fragments (`gh*_…`, `ghs_…`) from error messages before surfacing them.

## Future

Out of scope for this skill — flag to the user if they ask:

- GitHub App installation tokens (JWT mint flow) — would need a separate factory that exchanges an App private key for an installation token.
- Projects v2 mutations — supported by the tool today (use the GraphQL surface), but recipes deserve their own skill.
- Sub-issues management — works today by adding `headers: { "GraphQL-Features": "sub_issues" }`; recipes pending.
- Webhook receivers — these are a separate concern (a Slack/HTTP receiver, not a tool); out of scope for this fundamentals skill.
