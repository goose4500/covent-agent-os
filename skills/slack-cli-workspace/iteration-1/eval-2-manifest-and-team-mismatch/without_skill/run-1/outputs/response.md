# Slack CLI: `invalid_manifest` and `app_auth_team_mismatch`

## What the errors mean

- **`invalid_manifest`**: the app manifest/config the CLI is sending to Slack is not valid. This can be YAML/JSON/TypeScript syntax, unsupported fields, missing required fields, invalid scopes/settings, or values Slack rejects.
- **`app_auth_team_mismatch`**: the Slack app you are targeting belongs to a different workspace/team than the CLI auth token or selected workspace. This often happens after copying/editing config, switching workspaces, or reusing a local `.slack/` app link for the wrong team.

## Next checks / commands

1. Validate the manifest before deploy/run:

```bash
slack manifest validate
```

If your project uses an explicit manifest file, pass that file if supported by your CLI version:

```bash
slack manifest validate --manifest path/to/manifest.json
```

Fix the first reported manifest field error before retrying.

2. Check which Slack workspaces the CLI is authenticated to:

```bash
slack auth list
```

Note the team/workspace IDs and make sure you are using the intended workspace.

3. Check which app the local project is linked to:

```bash
slack app list
```

Compare the app ID and team/workspace with the app in the Slack app dashboard.

4. Inspect local project state for stale/wrong app mapping:

```bash
ls -la .slack
```

Look for local app mapping files such as `.slack/apps.json` or similar. Confirm the stored app/team IDs match the workspace from `slack auth list`.

5. If the app link is wrong, re-link to the correct app/workspace rather than editing IDs blindly:

```bash
slack app link
```

Or create/use a separate app for the correct workspace.

6. Retry only after both are true:

- `slack manifest validate` passes.
- The selected CLI auth workspace/team matches the app’s workspace/team.

If still unclear, rerun the failing command with debug/verbose output, if available, and look for the exact manifest field path or team ID being used.