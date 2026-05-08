# ADR 0002: Linear is execution truth

Date: 2026-05-08  
Status: accepted  
Related: FE-460, FE-531, FE-528, commit `c5fd843`

## Context

Slack is where messy work starts, but Slack threads are not durable execution systems. Pi can synthesize context, but Pi is not the source of truth. Git proves implementation, but not work intent/status.

FE-460 now supports converting an explicitly invoked Slack thread into a Linear issue in the Distribution backlog.

## Decision

Linear is the durable work queue for Covent Pi execution output. When a Slack thread becomes actionable work, Covent Pi should either draft a spec or, on explicit request, create a Linear issue with source evidence.

For the current MVP, this phrase is sufficient approval for issue creation:

```text
@Covent Pi create Linear issue
```

The created issue should include:

- Pi-generated title.
- Pi-generated spec/description.
- Source Slack thread permalink.
- Covent Pi request ID.

## Consequences

- Slack remains a conversation surface, not a backlog.
- Linear becomes the shared execution surface for team follow-through.
- The system must avoid creating issues from ambiguous ambient text.
- Future improvements should add preview/modal approval, richer metadata, and better dedupe/parent mapping.
