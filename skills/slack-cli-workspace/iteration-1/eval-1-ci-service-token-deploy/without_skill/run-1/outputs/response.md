Use the Slack CLI `deploy` command with the token passed explicitly from the CI secret:

```bash
slack deploy --token "$SLACK_SERVICE_TOKEN"
```

If your workspace/app selection is not implicit in the project, also pin it, for example:

```bash
slack deploy --app "$SLACK_APP_ID" --team "$SLACK_TEAM_ID" --token "$SLACK_SERVICE_TOKEN"
```

Be careful to:
- Store `SLACK_SERVICE_TOKEN` as a masked CI secret; never print it, commit it, or enable shell tracing around the command.
- Use the correct token for the target workspace/org and app environment.
- Pin `--app`/`--team` in CI when there is any chance of deploying to the wrong app or workspace.
- Treat service tokens as long-lived credentials: restrict access, rotate if exposed, and avoid passing them to untrusted build steps.
