# ADR 0010: Write-capable GitHub MCP access for pi-mom

Date: 2026-05-15
Status: accepted
Supersedes: ADR 0006
Related: Issue #121

## Context

ADR 0006 enabled the official GitHub remote MCP server for production `pi-mom` in a strictly read-only posture (`X-MCP-Readonly: true` + `X-MCP-Lockdown: true` + `directTools: false`). That posture let Covent Pi answer Slack-driven repository questions but blocked every write-capable PR tool the upstream MCP server can expose — including create-PR and merge-PR.

Issue #121 requires that future agents triggered from approved Slack channels be able to create and merge PRs in `goose4500/covent-agent-os` end-to-end, without dropping the secret-handling discipline ADR 0006 established (token values referenced by env var name only; never printed, logged, or committed).

The constraints carried forward from ADR 0006 are unchanged:

- Production `pi-mom` runs on Railway with persistent `PI_AGENT_DIR=/data/pi-agent`.
- `PI_MCP_JSON_B64` only seeds `${PI_AGENT_DIR}/mcp.json` when that file does not already exist (`apps/pi-mom/lib/pi-sdk-runner.mjs#seedMcpJsonFromEnv`). Rotating MCP config requires either deleting the persistent runtime file before redeploy, or carefully editing it in place.
- `pi-mcp-adapter` is loaded as a default-on extension (`apps/pi-mom/lib/pi-sdk-runner.mjs#buildPiMomExtensionFactories`). Tool availability is default-all per turn (`lib/pi-sdk-runner.mjs:430-435`), so every tool the adapter advertises is reachable from a normal Slack turn.

## Decision

Switch the production GitHub MCP server entry from "read-only / lockdown" to **"write-capable, gated by an explicit approval surface."**

Concretely:

1. The seeded GitHub MCP server entry **drops** `X-MCP-Readonly` and `X-MCP-Lockdown`, and keeps `X-MCP-Toolsets: context,repos,pull_requests,issues,actions` so the exposed surface stays scoped (no unrelated toolsets like discussions or copilot).
2. `directTools` stays `false` so the proxied `mcp` tool remains the single entry point and individual GitHub tools are not registered as top-level Pi tools. This keeps the tool-list footprint small and forces invocations through the `mcp({ server: "github", tool: "…" })` proxy where they are easier to audit in Slack streams.
3. Authentication continues to flow through `bearerTokenEnv: GITHUB_MCP_PAT`. The token value lives only in Railway secrets and is never embedded in `PI_MCP_JSON_B64`, this repo's docs, or any committed config.
4. PR create / merge actions are gated by an **explicit user request or approval in the originating Slack thread**. Covent Pi must not initiate `create_pull_request` or `merge_pull_request` calls speculatively; it may only invoke them after the human in the thread has explicitly asked for that action (e.g., "open a PR" / "merge it") or confirmed an interactive approval card. Routine read traffic (list / search / get) needs no extra approval.

The canonical sanitized example of the new config lives at `examples/mcp.example.json` under the `github` server entry.

## GitHub credential scope

The `GITHUB_MCP_PAT` referenced by `bearerTokenEnv` SHOULD be a fine-grained PAT scoped to `goose4500/covent-agent-os` only, with the minimum permissions required for the write-capable surface:

| Permission | Access | Why |
|------------|--------|-----|
| Metadata | Read | Required by every GitHub MCP call |
| Contents | Read / Write | Branch + file operations the model may need before opening a PR |
| Pull requests | Read / Write | Create, update, merge PRs |
| Issues | Read / Write | PR review threads and issue comments share this scope |
| Actions | Read | Inspect CI status of a PR before merging |

`Actions: write` is intentionally NOT granted; workflow dispatch / cancel is outside the approved surface for this posture. The temporary broad bootstrap token from ADR 0006 SHOULD be replaced with this fine-grained PAT as part of rolling this change to production.

## Persistent-volume reseed procedure

Because `/data/pi-agent/mcp.json` survives deploys, updating `PI_MCP_JSON_B64` alone will silently no-op. Operators rotating GitHub MCP config MUST follow this sequence:

1. Update the GitHub MCP server entry in the source `mcp.json` (use `examples/mcp.example.json` as the template).
2. Update Railway's `PI_MCP_JSON_B64` to the new `base64 -w0 < mcp.json` value. Do not paste token values; only env-var references should appear in the file.
3. Either:
   - **(preferred)** delete `/data/pi-agent/mcp.json` on the Railway volume, then redeploy `pi-mom`. The runner reseeds the file from `PI_MCP_JSON_B64` and logs `Seeded /data/pi-agent/mcp.json from PI_MCP_JSON_B64`, or
   - update `/data/pi-agent/mcp.json` in place via the Railway shell, taking care not to print or log token values, then restart `pi-mom`.
4. Verify from an approved Slack channel that `mcp` lists the GitHub server's write tools (`create_pull_request`, `merge_pull_request`, …) and not only read/list/search/get tools.
5. Confirm no token value appears in deploy logs, Slack replies, or committed files.

This procedure is also documented in `apps/pi-mom/README.md` so it lives next to the runner.

## Security posture

- Token values are referenced by env var name only. `PI_MCP_JSON_B64`, `examples/mcp.example.json`, ADRs, and runtime logs all contain `${GITHUB_MCP_PAT}` (or the equivalent env-name reference), never a literal token.
- Write capability is gated at the human-approval layer: the trusted-operator + channel-allowlist perimeter from ADR 0006 still applies; PR create/merge additionally requires explicit user intent in the originating Slack thread.
- The exposed surface is bounded by `X-MCP-Toolsets`. Removing `X-MCP-Readonly` and `X-MCP-Lockdown` does not silently widen the toolset beyond `context,repos,pull_requests,issues,actions`.
- `Actions: write` is intentionally withheld from the PAT so workflow dispatch / cancel cannot be invoked even if the model attempts it.

## Consequences

- Covent Pi can complete the full PR lifecycle (create / update / merge) for `goose4500/covent-agent-os` from approved Slack channels, replacing the previous read-only ceiling.
- The persistent `/data/pi-agent/mcp.json` file becomes the single source of truth for the live MCP server set. Operators MUST run the reseed procedure above when changing GitHub MCP config; updating only `PI_MCP_JSON_B64` will not roll out.
- The non-blocking compatibility warning from ADR 0006 (`pi-mcp-adapter` expecting `ui.theme.fg` which the Slack UI context does not provide) is unaffected and remains a follow-up.
- The temporary broad bootstrap token noted in ADR 0006 is now out of step with the documented credential scope; rotation to a fine-grained `goose4500/covent-agent-os`-scoped PAT becomes a Stage-1 follow-up after this ADR lands.

## Validation

Local check (gated on every CI run for `apps/pi-mom`):

```bash
bun --cwd apps/pi-mom run check
```

End-to-end canary (post-deploy, from an approved Slack channel):

1. Ask Covent Pi to list the GitHub MCP tools. Confirm `create_pull_request` and `merge_pull_request` appear in the result.
2. On a throwaway branch in `goose4500/covent-agent-os`, ask Pi to open a PR. Verify Pi waits for the explicit ask, then returns the new PR URL.
3. On a deliberately safe PR, give explicit merge approval in the thread. Verify Pi merges and returns the merge SHA.
4. Restart `pi-mom` and confirm the persistent `/data/pi-agent/mcp.json` survives and still advertises the write tools (the runner should log `mcp.json exists; not seeding`).
5. Inspect deploy logs, Slack replies, and the `PI_MCP_JSON_B64` payload; confirm no token value is present.

## Follow-ups

1. Rotate the temporary broad bootstrap token from ADR 0006 to a fine-grained PAT scoped to `goose4500/covent-agent-os` with the permissions table above.
2. Add a Slack approval card (`slack_approval_card`) wrapper around `merge_pull_request` so merges always surface an explicit confirm step even when the user's initial ask was unambiguous.
3. Resolve the duplicate `0007-*.md` ADR numbering noted in ADR 0009 follow-ups so future ADRs (this one is `0010`) sort cleanly.
