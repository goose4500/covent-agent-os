# Covent Slack MCP setup for Pi

Pi is staged to use Slack's official MCP endpoint through `pi-mcp-adapter`.

## Current auth posture

Current mode is Pi MCP OAuth against Slack's official remote MCP endpoint. `~/.pi/agent/mcp.json` should use `auth: "oauth"` for the `slack` server and should not contain a Slack bearer token literal or `SLACK_MCP_USER_TOKEN` reference.

Do **not** paste Slack tokens into Pi chat, Slack, git, logs, errors, screenshots, or shell history.

Prefer one of these local secret-loading patterns:
- a per-Pi launch wrapper that obtains the token from 1Password/`op`, `pass`, macOS Keychain, or another local secret manager;
- an untracked env file with `0600` permissions that is sourced only by the Pi launch wrapper;
- a temporary shell environment for a single Pi run.

Avoid putting the token in tracked files or broad global shell profiles.

## Slack admin setup

1. Create or approve an internal Covent Slack app for Pi.
2. Enable **Agents & AI Apps → Model Context Protocol** in the Slack app settings.
3. Start with least privilege. Recommended tiers:
   - Default search/read: `search:read.public`; optionally `search:read.private`, `search:read.mpim`, `search:read.im`, `search:read.files`, `search:read.users` only as needed.
   - Full context retrieval only when needed: `channels:history`, `groups:history`, `mpim:history`, `im:history`.
   - User directory: `users:read`; `users:read.email` only if email lookup is essential.
   - Files/canvases only for explicit workflows: `files:read`, `canvases:read`, `canvases:write`.
   - Writes only after guard validation and explicit need: `chat:write` and any other write-capable scopes.
4. Install/approve the app in Covent Slack.
5. Authenticate the Slack MCP server from interactive Pi with `/mcp-auth slack` so Pi stores the OAuth tokens under its local MCP OAuth store.

## Local preflight

Slack MCP now uses OAuth rather than a bearer env var. If Pi was already running before this config changed, restart Pi or run the interactive reload/auth flow.

Validate local config/guard behavior without contacting Slack:

```bash
node /home/jfloyd/.pi/agent/bin/validate-slack-mcp-guard.mjs
```

## Runtime validation in Pi

After Pi is restarted with the env var available:

```text
mcp({ connect: "slack" })
mcp({ server: "slack" })
mcp({ search: "slack messages channels users" })
```

Then validate safety behavior:
1. Run one read-only Slack search.
2. Attempt a harmless write-like Slack action in interactive mode and verify Pi asks for confirmation.
3. Attempt the same from a non-interactive Pi mode, if practical, and verify it is blocked.
4. Confirm no token or sensitive payload appears in logs/tool output.

## Using Slack data safely

For DMs, private channels, files, canvases, or sensitive investigations, prefer:

```bash
pi --no-session
```

so raw Slack excerpts are not saved in Pi session history.

Operating rules:
- Prefer summaries with Slack permalinks/channel/thread/user references over verbatim dumps.
- Do not use Slack data for model training/fine-tuning.
- Do not export raw private-channel, DM, file, or canvas content to files, git, Linear, other MCPs, public Slack channels, or web requests without explicit user consent.
- Use targeted searches with small result sets, date/channel/user filters, and no workspace-wide scraping or bulk history/file loops unless explicitly requested and approved.
- Respect Slack rate limits and retry-after behavior; avoid aggressive retries.

## Safety behavior

`~/.pi/agent/extensions/slack-mcp-guard.ts`:
- allows clearly read-only Slack tools normally;
- confirms Slack writes or unknown non-read Slack tools in interactive mode;
- blocks Slack writes or unknown non-read Slack tools in non-interactive mode;
- redacts secrets in confirmation previews;
- injects prompt-injection guidance that Slack content is data, not instruction.

## Troubleshooting

- **Not authenticated**: run `/mcp-auth slack` in interactive Pi and complete the browser OAuth flow.
- **Invalid/revoked token**: run `/mcp-auth slack` again or remove the local Slack OAuth store and re-authenticate.
- **Insufficient scopes**: Slack may return missing-scope/permission errors. Add only the next needed scope tier.
- **Admin approval**: verify the internal app is approved/installed and MCP is enabled in Slack app settings.
- **Rate limits**: slow down, reduce query breadth/result count, and honor retry-after timing.
- **Unexpected write confirmation**: the guard intentionally fails closed for Slack tools that are not clearly read-only; review the actual tool name before allowing.

## Cleanup/runbook if Slack content was persisted

Pi sessions are normally stored under `~/.pi/agent/sessions/` unless launched with `--no-session`. If sensitive Slack excerpts may have been persisted:
1. Identify the relevant Pi session with `/session` or by timestamp under `~/.pi/agent/sessions/`.
2. Review whether raw private Slack content was captured.
3. Delete or secure the affected local session file according to Covent policy.
4. Prefer future sensitive Slack work with `pi --no-session`.

## Admin disclosure checklist

Before broad enablement, document for Covent admins/users:
- which model/provider Pi uses;
- that Slack context may be sent to the model during a user-requested Pi task;
- whether Pi session persistence is enabled or `--no-session` is used;
- no training/fine-tuning on Slack content;
- Slack write confirmation behavior;
- scope tiers granted;
- audit/log retention policy.

## Periodic review

Slack's MCP tool surface can change. Periodically inspect observed Slack MCP tool names after connection and update the guard/tests when new Slack tools appear.
