# ADR 0001: Slack app mention is the primary Covent Pi UX

Date: 2026-05-08  
Status: accepted  
Related: FE-460, FE-531, commit `113c563`

## Context

The original `/thread->spec` command failed before reaching the app, and even the fixed `/thread-spec` command required users to copy/paste Slack thread URLs. That is useful for operators, but poor team UX.

Slack already gives an app mention inside a thread the right context: channel, user, message timestamp, and `thread_ts`.

## Decision

Use explicit in-thread app mentions as the primary MVP trigger:

```text
@Covent Pi draft spec
@Covent Pi create Linear issue
```

Keep `/thread-spec <Slack message/thread URL>` as a fallback/operator/debug route.

## Consequences

- Team workflow stays inside the thread where the context already lives.
- The system avoids broad channel-message surveillance and arbitrary intent inference.
- Users must explicitly invoke Covent Pi; ambient messages are not commands.
- Slash command remains available for cases where a URL-based operator path is useful.

## Notes

Future polished UX may add Slack message shortcuts or modal approvals, but the explicit app mention is the correct current primitive.
