# ADR 0006: Read-only GitHub MCP access for pi-mom

Date: 2026-05-14
Status: superseded by ADR 0010 and ADR 0015
Related: PR #76, ADR 0010 (write-capable posture, issue #121), ADR 0015 (retire GitHub MCP for gh CLI)

## Context

PR #76 merged the `pi-mcp-adapter` into `pi-mom`, allowing Covent Pi to connect to MCP servers from production Slack runs. Production `covent-pi-mom` on Railway now needs repository context for `goose4500/covent-agent-os` without granting write capability through Slack-triggered agent runs.

The live service runs with persistent `PI_AGENT_DIR=/data/pi-agent`. Railway production is configured with:

- `GITHUB_MCP_PAT` as a secret environment variable. The current value was sourced from an existing `gh` auth token as a temporary bootstrap and must not be documented or checked in.
- `PI_MCP_JSON_B64`, which seeds `${PI_AGENT_DIR}/mcp.json` on cold boot only when that file is missing.

A production cold boot confirmed the seed path with this log line:

```text
Seeded /data/pi-agent/mcp.json from PI_MCP_JSON_B64
```

## Decision

Enable read-only GitHub MCP access for production `pi-mom` via the official GitHub remote MCP server:

```text
https://api.githubcopilot.com/mcp/
```

The seeded MCP config uses bearer authentication via `bearerTokenEnv: GITHUB_MCP_PAT` and does not contain the token value. It limits the exposed GitHub surface with:

- `X-MCP-Toolsets: context,repos,pull_requests,issues,actions`
- `X-MCP-Readonly: true`
- `X-MCP-Lockdown: true`
- `directTools: false`
- `lifecycle: lazy`

`PI_MCP_JSON_B64` is a bootstrap mechanism, not the canonical runtime state. Because `/data/pi-agent` is persistent, changing the seed value will not overwrite an existing `/data/pi-agent/mcp.json`; operators must intentionally update or remove that file when changing production MCP config.

## Security posture

- No GitHub token values belong in repo docs, logs, ADRs, or checked-in MCP config.
- Production auth is injected through Railway secrets and referenced by environment variable name only.
- MCP requests are configured for read-only, lockdown mode and omit direct tool exposure.
- The current bootstrap token is broader than the target posture and is accepted only as a temporary production bootstrap.

## Consequences

- Covent Pi can answer Slack-approved repository questions using live GitHub context instead of relying only on stale local docs or model memory.
- The GitHub MCP integration is available lazily, reducing startup coupling to the remote MCP server.
- Production config is partly operational state in Railway plus `/data/pi-agent/mcp.json`; future operators must account for the persistent volume when rotating config.
- A known non-blocking compatibility issue remains: `pi-mcp-adapter` expects `ui.theme.fg`, while the Slack UI context does not provide that helper. This produces a non-fatal warning, but MCP still works.

## Validation evidence

Live canaries passed from approved Slack channels:

- `C0B30N60HGW`: GitHub MCP connected with 1 server / 25 tools and read the `goose4500/covent-agent-os` README. Thread: https://getcovent.slack.com/archives/C0B30N60HGW/p1778819847954909
- `C0B05VBGJKF`: read-only GitHub MCP confirmed the repo is reachable. Thread: https://getcovent.slack.com/archives/C0B05VBGJKF/p1778819931475979

## Follow-ups

1. Replace the temporary broad bootstrap token with a fine-grained GitHub PAT scoped only to `goose4500/covent-agent-os` with read-only Metadata, Contents, Pull requests, Issues, and Actions permissions.
2. Patch `pi-mcp-adapter` or the Slack UI context so missing `ui.theme.fg` does not emit a warning.
3. Document the operator procedure for rotating `/data/pi-agent/mcp.json` when MCP config changes after the initial seed.
