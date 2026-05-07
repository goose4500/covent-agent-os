# Slack CLI: `invalid_manifest` and `app_auth_team_mismatch`

## What the errors mean

- `invalid_manifest`: Slack rejected the app manifest generated from your config. This is usually a schema/format issue, an invalid field value, missing required config, invalid scopes/features/events, or a broken generated manifest after editing `manifest.ts`, `manifest.json`, or related app config.
- `app_auth_team_mismatch`: The CLI is using an app authorization that belongs to a different Slack workspace than the one selected. This often happens when multiple workspaces/apps are linked, or when `.slack/apps.dev.json` / `.slack/apps.json` points at an app from one team while your `--team` or active auth is for another.

## Safe next checks

Run these from the Slack app project directory:

```bash
slack version
```
Checks the installed Slack CLI version.

```bash
slack auth list
```
Shows which workspaces you are authorized for. Do not share tokens or credential files.

```bash
slack doctor --verbose
```
Checks project, auth, SDK, hooks, and API configuration.

```bash
slack manifest validate
```
Validates the manifest before running or deploying. Fix any reported manifest fields first.

```bash
ls -la .slack
```
Confirms the project has Slack CLI metadata.

Then inspect these files manually:

- `.slack/apps.dev.json` — local app links used by `slack run`
- `.slack/apps.json` — deployed app links used by deployed environments
- `manifest.ts` / `manifest.json` — recent config edits

## Team/app selection checks

If you have multiple workspaces or apps, be explicit:

```bash
slack app list --team <TEAM_ID_OR_NAME>
```
Lists apps for the intended workspace.

For local development, use the local environment/app:

```bash
slack run --team <TEAM_ID_OR_NAME> --app <LOCAL_APP_ID_OR_ENVIRONMENT>
```

For deployment, only after validation succeeds and you confirm the target workspace/app:

```bash
slack deploy --team <TEAM_ID_OR_NAME> --app <DEPLOYED_APP_ID_OR_ENVIRONMENT>
```

## Practical fix order

1. Fix `invalid_manifest` first with `slack manifest validate` output.
2. Confirm the intended workspace/team from `slack auth list`.
3. Check whether you are targeting local vs deployed app metadata.
4. Re-run with explicit `--team` and `--app` so the CLI cannot pick the wrong app/team pair.
5. Do not delete, uninstall, relink, or deploy to production until the target workspace and app are confirmed.
