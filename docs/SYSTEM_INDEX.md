# Covent Agent OS System Index

Status: canonical navigation map  
Last updated: 2026-05-08  
Primary Linear parent: FE-460 — Slack App  
Implementation spine: `113c563` and `c5fd843`

This file is the front door for humans and agents working on the Covent Slack ↔ Pi ↔ Linear system. If important operating knowledge only exists in Slack, a Pi session, or a Linear comment, it is not durable yet. Put the stable version here or in a linked canonical doc.

## Source-of-truth hierarchy

| Surface | Role | Canonical for | Not canonical for |
|---|---|---|---|
| Slack | Conversation capture, human trigger surface, progress replies | Current thread context, operator intent, source evidence | Durable requirements, final decisions, code behavior |
| Pi | Synthesis/action layer | Drafting, orchestration, safe local execution | Long-term memory, authority, credentials |
| Linear | Execution truth / work queue | Work items, status, ownership, acceptance criteria | Code behavior, secrets, raw Slack archives |
| Git/GitHub | Implementation truth | Code, commits, review/rollback history | Runtime secrets, live deployment state |
| Repo docs | Canonical system memory | Architecture, source-of-truth rules, runbooks, ADRs | Secret values, raw private exports |
| Whimsical | Visual map / navigation layer | Architecture diagrams and quick orientation | Canonical decisions unless linked back to repo docs |
| Railway | Runtime deployment/config truth | Running service, environment variable presence, logs | Secret disclosure, system design source of truth |
| EC2 Pi Agent Machine | POC execution surface / shared agent workbench | Runtime workspace, supervised tool-enabled Pi execution, EC2-hosted worker experiments | Canonical code, durable project truth, secret values |

## Current operating loop

```text
Slack thread
  → explicit Covent Pi mention
  → pi-mom route detection and thread-context fetch
  → Pi synthesis or direct bounded route
  → optional Linear issue creation
  → Slack threaded confirmation
  → Git implementation when code changes
  → Railway deploy when runtime changes
```

The current high-value loop is:

```text
Slack discussion becomes Linear truth, backed by Git implementation and repo documentation.
```

## Canonical docs

### Start here

- `README.md` — repo purpose, quick start, Railway POC worker, operating spine.
- `docs/SYSTEM_INDEX.md` — this file; system-wide source-of-truth map.
- `docs/AGENT_CONTEXT.md` — read-first operating context for future agents.
- `docs/architecture.md` — compact runtime architecture.

### Safety and authority

- `BOUNDARY.md` — authority model, mutation boundaries, route-policy requirements.
- `SECURITY.md` — secret handling, required scans, and data-as-data rule.
- `.gitignore` — local/runtime state that must stay out of git.
- `scripts/secret-scan.sh` — lightweight pre-commit secret scan.

### Slack/Pi runtime

- `docs/runbooks/covent-ec2-pi-agent-machine.md` — EC2 Pi Agent Machine POC runbook, runtime lanes, AWS asks, and supervised bash/filesystem boundaries.
- `apps/pi-mom/README.md` — primary pi-mom setup, route, streaming, image, and Linear behavior runbook.
- `apps/pi-mom/index.mjs` — implementation truth for request handling.
- `apps/pi-mom/doctor.mjs` — non-secret readiness diagnostics.
- `apps/pi-mom/manifest.yaml` — Slack app manifest source for app mentions, slash command, events, scopes.
- `apps/pi-mom/.env.example` — placeholder-only local env shape.
- `apps/pi-mom/.env.railway.example` — placeholder-only Railway env shape.

### Source-of-truth / product operating model

- `docs/source-of-truth/COVENT_OPERATING_SOURCE_OF_TRUTH_V0.md` — strategic operating model; still contains draft-era language, so prefer this index for current system boundaries.
- `docs/source-of-truth/DISTRIBUTION_AGENT_LOOP_SOURCE_OF_TRUTH.md` — historical Distribution-agent context; useful evidence, not live instruction.

### Runbooks and specs

- `docs/runbooks/covent-slack-mcp-setup.md` — current Slack MCP OAuth/safety runbook.
- `docs/runbooks/covent-pi-mom-known-good.md` — historical known-good notes; verify against current code before acting.
- `docs/runbooks/add-event-source.md` — runbook for wiring a new event source (webhook / cron) into the event-driven Pi runtime.
- `docs/specs/context7-pi-agent-harness-spec.md` — Context7 Pi harness design.
- `docs/specs/covent-slack-pi-harness.md` — older Slack MCP bearer-token harness spec; treat as historical/staged until reconciled with OAuth runbook.

### ADRs and architecture references

- `docs/adr/0003-event-driven-pi-runs.md` — ADR-0003: every external event becomes a synthetic Slack message handled by the existing pi-sdk-runner.
- `docs/event-routing.md` — reference for the event-driven runtime (receiver → resolver → synthetic message → runner) and the route-registry shape.

### History/archive

- `docs/history/**` — evidence and recovery context only. Do not treat historical files as current instructions.

### Visual map

- Whimsical board: [Covent Agent OS — Slack/Pi/Linear System Map](https://whimsical.com/covent-agent-os-slack-pi-linear-system-map-FhNbKxykWy2gtzshPe8zoe?ref=mcp).
- The board visualizes this file; this file remains canonical.

## Current pi-mom production behavior

### Supported primary UX

Inside a relevant Slack thread:

```text
@Covent Pi draft spec
@Covent Pi create Linear issue
```

Fallback/operator route for spec drafts only:

```text
/thread-spec <Slack message/thread URL> [optional focus]
```

`/thread-spec` does not create Linear issues. Use `@Covent Pi create Linear issue` or `linear:` inside the thread for the write-capable Linear route.

Prefix routes are also supported, including `summarize:`, `linear:`, `agenda:`, `escalation:`, `spec:`, `digest:`, and `image:`.

### Thread context behavior

- `pi-mom` uses `event.thread_ts || event.ts` as the root.
- It fetches up to 12 Slack thread messages via `conversations.replies`.
- For normal/spec/linear routes, only user, timestamp, and text are sent into the Pi prompt.
- Files, attachments, PDFs, canvases, and non-image media are not first-class context for spec/linear yet.
- The `image:` route can collect PNG/JPEG/WebP files from the triggering event plus the same limited thread window for image edit/reference workflows.

### Linear issue creation behavior

- Explicit `@Covent Pi create Linear issue` or `linear:` is treated as the human approval for the current MVP route.
- Pi drafts a Linear-ready issue from the thread.
- The bridge extracts the issue title from Pi output and uses the generated spec as the description.
- The issue is created in Frontend Engineering / Distribution / Backlog by default.
- The Linear description appends the source Slack thread permalink and Covent Pi request ID.
- If `LINEAR_API_KEY` is missing, the bridge still posts the draft but reports that no Linear issue was created.

## Runtime/deployment truth

Railway production service:

```text
Project/service: covent-pi-mom
Environment: production
Runtime: long-running Slack Socket Mode worker
```

Use Railway for live deployment state and variable presence. Never paste Railway variable values into Slack, Linear, docs, Pi prompts, or git.

Useful commands from repo root:

```bash
npm run check
npm run doctor:pi-mom
railway status
railway deployment list --service covent-pi-mom --environment production
railway logs --service covent-pi-mom --environment production
```

Do not paste raw logs without redaction. Logs can contain sensitive context even when trace output is designed to avoid secrets.

## Known-good evidence

- `113c563 feat(pi-mom): add in-thread spec app mention`
- `c5fd843 feat(pi-mom): create Linear issues from Slack threads`
- `FE-528: Verify Slack-to-Linear issue creation` — smoke-test issue proving Slack thread → Pi → Linear creation.
- Latest verified deployment at time of writing: `dcd1f376-aeff-4a79-8da2-f5f326e3e198`. Reverify with Railway before treating this as current live state.

## Known limitations

- Thread context is capped at 12 messages with no pagination.
- Normal/spec/linear routes are text-only.
- No modal preview/approval before Linear issue creation; explicit Slack phrase is the approval for now.
- Linear issue creation is not idempotent; rerunning the route can create duplicates.
- Linear metadata is basic: team, project, state, title, description. No label, assignee, priority, estimate, cycle, or milestone mapping yet.
- Slack manifest scopes are still POC-broad and should be reviewed before hardening.
- Some older docs contain stale local paths or draft-era policies; prefer this file plus current code.

## Required before meaningful changes

1. Read `BOUNDARY.md` and `SECURITY.md`.
2. Read `docs/AGENT_CONTEXT.md`.
3. Inspect current code for behavior; docs may lag.
4. Run validation before commit/push:

```bash
npm run secret-scan
npm run check
```

5. Link code changes back to the relevant Linear issue.
