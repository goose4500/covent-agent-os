# Automation boundary

## First principles

Covent agent automation should be powerful, observable, and reversible.

```text
Slack receives asks and returns progress/results.
Pi reasons and executes bounded workflows.
Tools provide capabilities but do not create authority.
Linear/GitHub/docs hold durable truth.
Humans approve risky external mutations.
```

## Default authority model

| Surface | Role | Default authority |
|---|---|---|
| Slack | Cockpit, intake, progress, approval | Read current context; write only through approved routes |
| Pi | Reasoning/execution runtime | Can plan, draft, run local checks; no external writes unless route allows |
| MCP tools | Bounded capability adapters | Read-first; writes require explicit current approval |
| Linear | Durable work truth | Draft-first by default; mutation only after explicit approval or an approved write-capable route such as `@Covent Pi create Linear issue` |
| GitHub/Git | Code truth/review/rollback | Local commits OK after scan; remote push only after repo boundary is understood |
| Browser/Chrome | Visible supervised action surface | Read/inspect by default; consequential actions require approval |

## Route policy

Every Slack/Pi route should declare:

1. Input shape.
2. Allowed context.
3. Tools it may call.
4. Whether approval is required.
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
