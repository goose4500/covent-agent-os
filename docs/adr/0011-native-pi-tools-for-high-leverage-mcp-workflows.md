# ADR 0011: Package high-leverage MCP workflows as native Pi tools

Date: 2026-05-15
Status: accepted
Related: ADR 0010 (write-capable GitHub MCP for pi-mom), PR #123 (github-pr-tools spike)

## Context

ADR 0010 unlocked write-capable GitHub MCP access for pi-mom. With that toggle flipped, the model can technically perform the full PR lifecycle through the proxy at `mcp({ server: "github", tool: "create_pull_request", … })`. That works, but the proxy shape has three operational rough edges that recur across every MCP server we add to the bridge (GitHub, Slack, and the Linear MCP variant on the way):

1. **Discovery cost.** Every novel mutation costs at least one extra round-trip: the model calls `mcp({ search: "create pull request" })` before it knows the tool's exact name and parameter shape. For frequent actions this is wasted tokens and latency on every turn.
2. **Vendor name drift.** Upstream MCP servers can rename tools (`create_pull_request` → `pulls.create`) or restructure parameters in a minor version bump. Anything in our prompt templates, skill markdown, or ADRs that names the upstream tool breaks silently when that happens.
3. **No room for cross-cutting UX.** Approval cards (`slack_approval_card`), structured telemetry, canvas sink details, and credential redaction all have to live in either the SDK or the MCP server. We can't inject them into a single proxied tool call without forking the upstream server.

The GitHub PR spike (PR #123) demonstrates the alternative. Four hand-written Pi tools — `github_get_pr`, `github_pr_comment`, `github_create_pr`, `github_merge_pr` — call the GitHub REST API directly with the same `GITHUB_MCP_PAT`, own a Slack approval card on the mutating ones, redact PAT-shaped substrings from error paths, and return both a text summary (for the model) and a structured `details` payload (for sinks / future observability). The tools cost ~600 lines of TypeScript total and are exercised by 13 dedicated test cases plus the existing SDK loader smoke check.

## Decision

For a small, opinionated set of **high-leverage, high-frequency MCP workflows**, ship a native Pi extension that wraps the underlying API directly. Use the criteria below to decide which workflows clear the bar; everything else continues to ride the `mcp` proxy.

A workflow is **in scope** for a native wrapper when **at least two** of the following hold:

1. The model invokes it often enough that the MCP discovery round-trip is a real token / latency tax (rule of thumb: ≥1× per typical Slack turn for the relevant workflow).
2. The action is mutating or destructive and benefits from a forced human-in-the-loop UX (`ctx.ui.confirmWithPreview` approval card with a server-truth preview).
3. The tool name appears in prompt templates, skill markdown, or ADRs, so vendor rename drift would be expensive to chase.
4. The error / response shape benefits from a structured `details` payload that downstream sinks (canvas-sink, slack-sink, telemetry) want to consume.

A workflow is **out of scope** when:

- It's read-only and rarely invoked (one-off audits, low-traffic listings). Use the MCP proxy.
- The underlying tool surface is large and the agent uses many shapes of it (e.g. the GitHub `code_search` toolset, the Slack search surface). Re-export via `directTools` on the MCP server entry; don't hand-write wrappers for dozens of tools.
- We don't own or proxy the credential. If auth lives entirely inside the MCP server (OAuth refresh, etc.), reaching past it duplicates state management for no win.

## What "native wrapper" means in practice

A native wrapper follows the shape established by `extensions/linear-tools.ts`, `extensions/slack-interactive-tools.ts`, and `extensions/github-pr-tools.ts`:

- Lives at `extensions/<surface>-<workflow>-tools.ts`.
- Registered in `buildPiMomExtensionFactories` (`apps/pi-mom/lib/pi-sdk-runner.mjs`) so it's default-on; placement near related extensions keeps the array readable.
- Exports a default factory with zero required config plus a non-default `create…Factory` that accepts injectable `fetch` + `env`, so tests run hermetically.
- Mutating tools own their approval card via `ctx.ui.confirmWithPreview`. Build the preview from server-truth (fetch state first, don't trust the model's args). Read tools do not show approval prompts.
- Errors return `isError: true` and never leak token-shaped strings. Use the redactor pattern in `extensions/github-pr-tools.ts` (`gh*_[REDACTED]`, `Authorization: [REDACTED]`) + `extensions/linear-tools.ts` (`lin_api_[REDACTED]`).
- A dedicated `apps/pi-mom/test-<workflow>-tools.mjs` covers, at minimum: registration shape, happy paths for read + write, approval rejection blocks the API call, missing-env errors, `AbortSignal`, HTTP error with secret redaction.
- Wired into `apps/pi-mom/package.json`'s `check` script and the SDK loader smoke check in `apps/pi-mom/test-pi-sdk-runner.mjs` (factory count + tool-name registration check).

## Trade-offs accepted

- **Maintenance.** A native wrapper is more code than zero code. We accept the cost because the wins (approval UX, stable contracts, redaction, structured details) compound across every model turn that touches the workflow.
- **Upstream API drift.** REST APIs can also break, but vendors carry a wider compatibility window than any single MCP server's tool schema, and the redaction + error-shape contract is ours regardless of which underlying API moves under us.
- **Token surface.** Each wrapper adds a top-level tool definition to the active tool list. We keep the wrapper count small (~4 per surface today) so the prompt budget stays bounded; revisit the cap if it ever crosses ~15.
- **Two paths for the same capability.** Native wrappers and the `mcp` proxy coexist. The model can call either. This is fine — the wrappers are an opinionated fast path for the frequent / risky ops, not a replacement for the proxy.

## Alternatives considered

**Flip `directTools: true` on the GitHub MCP server.** Simpler — surfaces every upstream tool as a top-level Pi tool with no new code. Rejected for the high-leverage workflows because (a) we lose the approval-card chokepoint on mutating ops, (b) tool names are whatever the upstream MCP picks (vendor rename = silent breakage), (c) we can't redact PAT-shaped strings on the upstream error path. `directTools` remains the right answer for medium-traffic, low-risk surfaces.

**Use the MCP proxy unchanged for everything.** Cheapest in code. Rejected for the four workflows in scope today because the discovery round-trip and approval-UX gap dominate the trade.

**Fork the upstream GitHub MCP server to add redaction + approval UX server-side.** Would let cross-cutting concerns live in the MCP layer rather than per-wrapper. Rejected — drags us into a fork-maintenance treadmill for a small surface area we control well from the bridge side.

## Consequences

- Future MCP-shaped capabilities reach the model through whichever shape fits the criteria: native wrappers when this ADR's criteria are met, `directTools` for medium-traffic surfaces, the bare `mcp` proxy for everything else.
- Each native wrapper inherits the same test surface and the same redaction discipline; deviations get caught in review against the checklist in "What 'native wrapper' means in practice."
- The MCP proxy stays available and the surface beyond what we wrap is unchanged. The proxy and the native wrappers coexist; the model is free to fall back to the proxy when it needs a tool the wrappers don't cover.
- New surfaces (the next MCP server we wire up) get evaluated against the criteria here before we decide between native wrapper, `directTools`, or proxy.

## Follow-ups

1. **`slack_send_message` native wrapper.** High-frequency, mutating, currently behind the `mcp` proxy (`SLACK_MCP_DIRECT_TOOLS` is opt-in via env). Strong candidate for the next wrapper pass.
2. **Canvas / observability sink for native-tool calls.** Native wrappers already emit structured `details`; surface them in `canvas-sink.mjs` so reviewers can scrub past tool calls in the live thread canvas.
3. **Diff-anchored PR review-comment tool.** `github_pr_comment` covers issue-style PR comments. Diff-anchored review comments live behind a different REST endpoint; add a `github_pr_review` wrapper when we start running automated review passes that need to point at specific lines.
4. **Linear MCP variant evaluation.** The current Linear extension calls the GraphQL API directly. If a Linear MCP server lands upstream, re-evaluate against this ADR's criteria before swapping.
