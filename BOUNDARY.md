# Automation boundary

## First principles

Covent agent automation should be powerful, observable, and reversible.

```text
Slack receives asks and returns progress/results.
Pi reasons and executes tool-enabled workflows.
Tools provide capabilities but do not create authority.
Linear/GitHub/docs hold durable truth.
Humans approve risky external mutations.
```

## Default authority model

| Surface | Role | Default authority |
|---|---|---|
| Slack | Cockpit, intake, progress, approval | Read current context; reply in the active thread; other Slack mutations require explicit current approval |
| Pi | Reasoning/execution runtime | Default-on registered tools/skills/app extensions in Slack Pi; authority still comes from current user intent, not from tool availability |
| MCP/tools | Capability adapters | Tool-enabled by default; external/consequential writes require explicit current approval |
| Linear | Durable work truth | Mutation only after explicit approval or an explicit user request such as `@Covent Pi create Linear issue` / `linear:` |
| GitHub/Git | Code truth/review/rollback | Local commits OK after scan; remote push only after repo boundary is understood |
| Browser/Chrome | Visible supervised action surface | Read/inspect by default; consequential actions require approval |

## Route policy

Slack/Pi route prefixes shape workflow instructions only. They do not define tool allowlists. Every route should still document:

1. Input shape.
2. Expected context.
3. Workflow intent.
4. When explicit user approval is required.
5. Output format.
6. Failure behavior.
7. Redaction/logging behavior.

## Mutations requiring explicit current approval

- Posting/uploading/updating/deleting Slack content outside the active response route.
- Creating/updating/deleting Linear issues/comments/statuses outside approved explicit routes.
- Creating/pushing GitHub repos, branches, PRs, or releases.
- Sending email or external messages.
- Editing Whimsical/Figma/browser state with real-world consequences.
- Exporting private Slack/Linear/Gmail/browser/session data to files or third-party tools.

## Never commit

Secrets, raw private exports, logs, pidfiles, caches, generated images, browser profiles/cookies, raw Pi sessions, or unredacted Linear/Slack dumps.
