# ADR 0003: Repo docs are canonical system truth

Date: 2026-05-08  
Status: accepted  
Related: FE-531

## Context

The system spans Slack, Linear, GitHub, Railway, Pi sessions, MCP configs, Whimsical, and local docs. Without a clear source-of-truth hierarchy, future agents will act on stale Pi logs, old Slack comments, or historical docs.

## Decision

The repo docs are the canonical system memory. Stable system knowledge belongs in tracked Markdown files, especially:

- `docs/SYSTEM_INDEX.md`
- `docs/AGENT_CONTEXT.md`
- `BOUNDARY.md`
- `SECURITY.md`
- `docs/adr/**`
- current app runbooks under `apps/pi-mom/README.md` and `docs/runbooks/**`

Historical files and Pi sessions are evidence, not authority.

## Consequences

- Important decisions must be promoted from Slack/Linear/Pi sessions into repo docs.
- Future agents should read the docs before acting.
- Docs must be kept linked to Linear issues and commits.
- Secret values, raw private exports, and local runtime state must never be placed in canonical docs.
