# Safe diagnosis for `slack run` using the wrong workspace/app

Run these from the repo root. They are inspection-only; do **not** run `slack run`, `slack deploy`, `slack app link`, or `slack app delete` yet.

```bash
# 1) Confirm where you are and what Slack project metadata exists
pwd
git rev-parse --show-toplevel 2>/dev/null || true
find . -maxdepth 3 -type f \( -name 'manifest.*' -o -path './.slack/*' \) -print

# 2) Inspect the app/workspace mapping stored in the repo
ls -la .slack 2>/dev/null || true
cat .slack/apps.json 2>/dev/null || true
cat .slack/config.json 2>/dev/null || true

# 3) Inspect manifest values that identify the app
find . -maxdepth 3 -type f -name 'manifest.*' -print -exec sed -n '1,220p' {} \;

# 4) Check which Slack workspaces this machine is logged into
slack auth list

# 5) List apps visible to the intended workspace and compare app IDs/names
# Replace T123... with the intended workspace/team ID from `slack auth list`.
slack app list --team T123...

# 6) If multiple workspaces are authenticated, repeat for each suspicious team ID
slack app list --team TOTHER...
```

What to compare:

- The intended workspace/team ID from `slack auth list`.
- Any app IDs and default app mapping in `.slack/apps.json`.
- The app name/settings in `manifest.*`.
- The app ID/name returned by `slack app list --team ...`.

If the repo metadata points at the wrong app/workspace, stop there and decide the fix explicitly, e.g. relink to the right existing app or remove/regenerate local Slack metadata. Back up `.slack/apps.json` before changing it.