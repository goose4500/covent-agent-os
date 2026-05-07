Use this in CI from the Slack app project directory:

```bash
slack deploy -s --token "$SLACK_SERVICE_TOKEN"
```

Be careful to:

- Store `SLACK_SERVICE_TOKEN` as a CI secret/env var; never echo, log, commit, or print the raw token.
- Confirm the token belongs to the intended Slack workspace and has permission to deploy the intended app.
- Confirm you are deploying the right environment/app; add explicit `--team <team-id-or-name>` or `--app <app-id-or-env>` if your project can target multiple workspaces/apps.
- Validate before deploying when possible:
  ```bash
  slack manifest validate --token "$SLACK_SERVICE_TOKEN"
  ```
- Treat this as a deployed/production-impacting action: verify scopes, manifest changes, triggers, env vars, and any required admin approvals before the workflow runs.
