# Slack slash command auto-sync

Slack slash commands are declared once, next to the capability that handles them, and synced to the Slack app manifest by a script. CI blocks any PR where the manifest and declarations drift; a separate workflow pushes the manifest to Slack on merge to `main`.

## Declaring a `/` command

### From a skill (`skills/<name>/SKILL.md`)

Add a `slash_commands:` block to the frontmatter:

```yaml
---
name: slack-spec-draft
description: ...
slash_commands:
  - command: /thread-spec
    description: Draft a spec from a Slack thread
---
```

Optional fields per entry: `usage_hint`, `should_escape` (defaults to `false`).

### From an extension (`extensions/<name>.ts`)

Create a sibling file `extensions/<name>.slash-commands.json`:

```json
[
  { "command": "/linear-new", "description": "File a Linear issue from this thread" }
]
```

### From an MCP server (`.mcp.json`)

Attach a `slashCommands` array to the server entry:

```json
{
  "mcpServers": {
    "linear": {
      "url": "...",
      "slashCommands": [
        { "command": "/linear-search", "description": "Search Linear issues" }
      ]
    }
  }
}
```

## After declaring, wire a handler

Every declared command must have a matching `app.command("/xxx", ...)` registration in `apps/pi-mom/index.mjs`. The handler enforcement test (`test-slash-command-handlers.mjs`) fails CI if you forget. See `handleThreadSpecSlashCommand` as the canonical pattern: parse the Slack input, route through `handleRequest` with `mode: "slash_command:/xxx"`, let the model pick the right skill from there.

## Sync and push

```bash
# Regenerate manifest.yaml from declarations (run after editing any source).
bun scripts/sync-slack-manifest.mjs

# CI-style drift check — exit 1 if manifest.yaml is out of sync.
bun scripts/sync-slack-manifest.mjs --check

# Regenerate + push to Slack via apps.manifest.update.
SLACK_APP_CONFIG_TOKEN=xoxe-... SLACK_APP_ID=A0XXXXXX \
  bun scripts/sync-slack-manifest.mjs --push
```

`--push` is normally run by `.github/workflows/slack-manifest-push.yml` on push to `main` — local pushes are for emergencies only.

## Required secrets

The `slack-manifest-push` workflow needs two repo secrets:

- `SLACK_APP_CONFIG_TOKEN` — App Configuration Token (`xoxe-…`). Rotates every ~12h; get a fresh one from <https://api.slack.com/apps> → "Your App Configuration Tokens".
- `SLACK_APP_ID` — the target Slack app ID.

Both are referenced in `.env.example` for local visibility but should only be set as CI secrets — never committed.

## How it works

1. `apps/pi-mom/lib/slash-command-discovery.mjs` walks `skills/`, `extensions/`, and `.mcp.json` and returns a sorted list of commands. Name collisions across sources raise a fatal error.
2. `apps/pi-mom/lib/slack-manifest-sync.mjs` does a line-scoped replace of the `slash_commands:` block inside `apps/pi-mom/manifest.yaml`. Nothing else in the manifest is touched.
3. `scripts/sync-slack-manifest.mjs` ties them together and exposes `--check` / `--write` / `--push` modes.
4. `.github/workflows/ci.yml` runs `--check` on every PR.
5. `.github/workflows/slack-manifest-push.yml` runs `--push` when the manifest or any declaration source changes on `main`.

## Removing or renaming a command

Delete the entry from the source (SKILL.md, `.slash-commands.json`, or `.mcp.json`) **and** delete the matching `app.command("/xxx", ...)` from `index.mjs`. Run the sync; commit the regenerated manifest. The push workflow takes care of removing the command from Slack.
