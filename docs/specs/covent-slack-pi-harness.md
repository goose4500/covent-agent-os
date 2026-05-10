# Covent Slack access for Pi harness

Status: **Archived safe-mode spec — historical, non-authoritative for trusted internal speed mode.**

This document preserves the earlier passive/read-mostly Slack posture. Where it requires least-privilege staging, draft-first behavior, or broad write avoidance beyond `SECURITY.md`/`BOUNDARY.md`, treat it as safe-mode history rather than current operating guidance. Current trusted internal speed mode may use approved internal scopes and write-capable workflows when ownership, auditability, and secret/data-handling requirements remain satisfied.

## Goal
Give Pi useful, permission-aware access to Covent Slack as project memory/context while preventing accidental Slack writes, token leakage, prompt-injection/data exfiltration, and unnecessary retention of raw Slack content.

## Primary architecture
- Use Slack's official remote MCP endpoint: `https://mcp.slack.com/mcp`.
- Use Pi's existing `pi-mcp-adapter` instead of a bespoke Slack API scraper.
- Keep Slack behind the MCP proxy (`directTools: false`) to avoid bloating Pi's prompt and to centralize safety policy.
- Current local/staged auth mode: bearer user token from env var `SLACK_MCP_USER_TOKEN`.
- Target future auth mode: Slack OAuth/PKCE or equivalent first-class Pi MCP OAuth support with safe client config and token rotation.
- Never commit or paste Slack tokens, OAuth client secrets, or app credentials into chat, git, logs, screenshots, or tracked config.

## Current Pi MCP config
`~/.pi/agent/mcp.json` should preserve existing servers and include:

```json
"slack": {
  "url": "https://mcp.slack.com/mcp",
  "auth": "bearer",
  "bearerTokenEnv": "SLACK_MCP_USER_TOKEN",
  "lifecycle": "lazy",
  "idleTimeout": 10,
  "directTools": false,
  "debug": false
}
```

Do not put a token literal or OAuth client secret in `mcp.json`.

## Slack data handling posture
Default posture: **do not store or copy raw Slack content unless explicitly approved for the workflow**.

- Prefer summaries, decisions, timestamps, channel/thread/user references, and Slack permalinks over verbatim excerpts.
- For DMs, private channels, files, canvases, or sensitive investigations, prefer launching Pi with `pi --no-session` so Slack excerpts are not saved in Pi session JSONL.
- Do not train, fine-tune, benchmark, or otherwise reuse model/provider data on Slack content.
- Do not export raw private-channel, DM, file, or canvas content to files, git, Linear, other MCPs, public Slack channels, or external web requests without explicit user consent.
- If Covent later approves retaining Slack-derived content, require explicit business/legal basis, local encryption/permissions, retention/deletion controls, and a summary/permalink-first policy.

## Scope tiers / least privilege (archived safe-mode baseline)
Archived safe-mode guidance: start read-only or read-mostly and grant broader scopes only when the workflow needs them and the guard/tests are passing. In trusted internal speed mode, this section is advisory history; approved internal Slack app scopes may be broader when needed for fast execution, provided `SECURITY.md` principles, admin approval, and guard/audit expectations are preserved.

### Tier 1: default search/read discovery
- Public search: `search:read.public`
- Optional, only if needed and approved: `search:read.private`, `search:read.mpim`, `search:read.im`
- Optional file/user search: `search:read.files`, `search:read.users`

### Tier 2: full context retrieval
Only when search snippets are insufficient and full channel/thread context is required:
- `channels:history`
- `groups:history`
- `mpim:history`
- `im:history`

### Tier 3: user directory/profile
- `users:read`
- `users:read.email` only if email lookup is essential.

### Tier 4: files/canvases
- `files:read` only if direct file download/content access is needed.
- `canvases:read` for canvas reading.
- `canvases:write` only for explicit canvas-writing workflows.

### Tier 5: writes/actions
Enable only after local guard validation and explicit admin/user need:
- `chat:write`
- any write-capable canvas/file/channel scopes.

Optional future architecture: separate `slack_read` and `slack_write` apps/tokens/server entries so routine context retrieval cannot write by construction. Do not add this until the user/admin chooses the architecture and creates the corresponding apps/tokens.

## Safety guard requirements
`~/.pi/agent/extensions/slack-mcp-guard.ts` must:
- Detect Slack through proxied MCP calls (`event.toolName === "mcp"` with `input.server === "slack"` or Slack-prefixed tool names) and future direct `slack_*` tools.
- Allow clearly read-only tools (`search`, `list`, `get`, `fetch`, `history`, `info`, `lookup`, `read`, `find`, etc.).
- Confirm write-like tools in interactive mode and block them in non-interactive mode.
- Fail closed for unknown Slack tools that are not clearly read-only.
- Redact secrets in confirmation previews.
- Inject system guidance that treats Slack content as untrusted data, not instructions.

## Safe audit metadata
If audit logging is added, log only low-sensitivity metadata:
- tool/server/action category
- timestamp
- target channel/user ID when needed
- Slack permalink/thread timestamp when available
- allow/block decision and reason
- model/version if useful

Never log token values, authorization headers, full message bodies, file contents, or canvas contents in audit records.

## Operational guidance
- Use targeted searches with date/channel/user filters where possible.
- Avoid workspace-wide scraping, bulk history pulls, and bulk file downloads unless explicitly requested and approved.
- Respect Slack rate limits and retry-after behavior; do not aggressively retry 429s.
- Keep `debug: false` by default to avoid accidental sensitive logging.

## Validation
Before real use:

```bash
node /home/jfloyd/.pi/agent/bin/validate-slack-mcp-guard.mjs
```

After the token is available to a fresh Pi process:

```text
mcp({ connect: "slack" })
mcp({ server: "slack" })
mcp({ search: "slack messages channels users" })
```

Then test that a harmless write-like Slack call triggers confirmation in interactive mode and is blocked in non-interactive mode.

## Future OAuth/PKCE target
The bearer env-token mode is staging. Longer-term, prefer Slack OAuth/PKCE or a Pi-supported OAuth flow that avoids embedded client secrets, handles token rotation/expiry, and respects Slack's desktop/localhost redirect constraints.

Future notes to validate before implementation:
- Slack MCP uses confidential OAuth for MCP clients and a registered Slack app identity.
- Desktop/localhost PKCE flows have special constraints, including user scopes and refresh-token expiry behavior.
- Do not embed client secrets in distributed/native code.
- Store tokens in secure local storage with revocation/deletion procedures.

## Deliverables currently expected
1. This spec.
2. Updated `~/.pi/agent/mcp.json` with Slack MCP server skeleton using `SLACK_MCP_USER_TOKEN` env var.
3. `~/.pi/agent/extensions/slack-mcp-guard.ts` safety extension.
4. `~/.pi/agent/docs/covent-slack-mcp-setup.md` setup/runbook.
5. `~/.pi/agent/bin/validate-slack-mcp-guard.mjs` local smoke test.
