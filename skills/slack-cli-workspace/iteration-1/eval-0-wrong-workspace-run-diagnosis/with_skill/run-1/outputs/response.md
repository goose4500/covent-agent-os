# Safe diagnosis for `slack run` using the wrong workspace/app

Run only read-only checks first; do **not** edit `.slack/`, relink apps, uninstall, deploy, or log out yet.

```bash
# 1. Confirm you are in the intended Slack app repo
pwd
ls -la

# 2. Check CLI version
slack version

# 3. List authorized workspaces without exposing tokens
slack auth list

# 4. Run project diagnostics
slack doctor

# 5. Inspect project-level app links used by the Slack CLI
ls -la .slack
find .slack -maxdepth 1 -type f -name 'apps*.json' -print

# 6. Validate the manifest generated from this repo
slack manifest validate

# 7. If multiple workspaces/apps appear, list app installs for the intended team
slack app list --team <INTENDED_TEAM_ID_OR_NAME>
```

What to compare:

- `slack auth list`: which workspaces your local CLI can access.
- `.slack/apps.dev.json`: local/dev app link, commonly used by `slack run`.
- `.slack/apps.json`: deployed app link, commonly used by `slack deploy`.
- `slack doctor`: project/app/team selection warnings.
- `slack app list --team ...`: whether the intended app is installed in the intended workspace.

If the wrong workspace/app is selected, the next non-destructive step is usually to run with explicit selectors, for example:

```bash
slack run --team <INTENDED_TEAM_ID_OR_NAME> --app <INTENDED_APP_ID_OR_ENVIRONMENT>
```

Only after confirming the mismatch should you consider changing project links with `slack app link` or reinstalling anything.