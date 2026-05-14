# Covent Agent OS System Index

Status: canonical navigation map
Last updated: 2026-05-12 (post-foundation-rebuild)
Primary Linear parent: FE-460 — Slack App
Implementation truth: `main` HEAD (production cutover merge: `1ab169c`)
Foundation-v2 cutover commits: `a75858f` (Stage 10) → `1ab169c` (merge)

This file is the front door for humans and agents working on the Covent Slack ↔ Pi ↔ Linear system. If important operating knowledge only exists in Slack, a Pi session, or a Linear comment, it is not durable yet. Put the stable version here or in a linked canonical doc.

## Source-of-truth hierarchy

| Surface | Role | Canonical for | Not canonical for |
|---|---|---|---|
| Slack | Conversation capture, human trigger surface, progress replies | Current thread context, operator intent, source evidence | Durable requirements, final decisions, code behavior |
| Pi | Synthesis/action layer (in-process SDK) | Drafting, orchestration, safe local execution | Long-term memory, authority, credentials |
| Linear | Execution truth / work queue | Work items, status, ownership, acceptance criteria | Code behavior, secrets, raw Slack archives |
| Git/GitHub | Implementation truth | Code, commits, review/rollback history | Runtime secrets, live deployment state |
| Repo docs | Canonical system memory | Architecture, source-of-truth rules, runbooks, ADRs | Secret values, raw private exports |
| Whimsical | Visual map / navigation layer | Architecture diagrams and quick orientation | Canonical decisions unless linked back to repo docs |
| Railway | Runtime deployment/config truth | Running service, environment variable presence, logs | Secret disclosure, system design source of truth |
| EC2 Pi Agent Machine | POC execution surface / shared agent workbench | Runtime workspace, supervised tool-enabled Pi execution | Canonical code, durable project truth, secret values |

## Current operating loop

```text
Slack thread
  → @Covent-Agent mention OR Assistant tab message
  → dispatchToAction({surface, channel, threadTs, …})
  → route catalog(routes.mjs) → {route instruction + workflow label}
  → in-process Pi session (createAgentSession + SessionManager) resumes per thread
  → runner activates all registered tools/skills/app extensions by default
  → streaming response via chat.startStream + heartbeat
  → optional canvas mirror (spec: route)
  → optional Linear comment/issue (linear: route via 3 modular Pi custom tools)
  → optional explicit Slack approval/choice/input cards when the model uses Slack UI tools
  → Slack threaded confirmation
  → Git implementation when code changes
  → Railway auto-deploy when main updates
```

The current high-value loop:

```text
Slack discussion becomes Linear truth, backed by Git implementation and repo documentation.
```

## Canonical docs

### Start here

- [`README.md`](../README.md) — repo purpose, quick start, production deploy table, operating spine.
- [`docs/SYSTEM_INDEX.md`](SYSTEM_INDEX.md) — this file; system-wide source-of-truth map.
- [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md) — read-first operating context for future agents.
- [`docs/architecture.md`](architecture.md) — post-rebuild canonical architecture (3 primitives, file tree, routes, extensions, deploy lifecycle).

### Safety and authority

- [`BOUNDARY.md`](../BOUNDARY.md) — authority model, mutation boundaries, route-policy requirements, secret handling, and data-as-data rule.
- `.gitignore` — local/runtime state that must stay out of git.
- `scripts/secret-scan.sh` — lightweight pre-commit secret scan.

### Slack/Pi runtime

- [`docs/runbooks/covent-ec2-pi-agent-machine.md`](runbooks/covent-ec2-pi-agent-machine.md) — EC2 Pi Agent Machine POC runbook, runtime lanes, AWS asks, and supervised bash/filesystem boundaries.
- [`docs/runbooks/foundation-v2-cutover-2026-05-12.md`](runbooks/foundation-v2-cutover-2026-05-12.md) — the 2026-05-12 cutover lifecycle; reusable pattern for future blue-green Railway migrations.
- [`apps/pi-mom/README.md`](../apps/pi-mom/README.md) — primary pi-mom setup, route, streaming, and Linear behavior runbook.
- [`apps/pi-mom/index.mjs`](../apps/pi-mom/index.mjs) — implementation truth for request handling.
- [`apps/pi-mom/lib/routes.mjs`](../apps/pi-mom/lib/routes.mjs) — route labels/instructions/help/status; prefixes shape workflow, not tool access.
- [`apps/pi-mom/doctor.mjs`](../apps/pi-mom/doctor.mjs) — non-secret readiness diagnostics.
- [`apps/pi-mom/manifest.yaml`](../apps/pi-mom/manifest.yaml) — Slack app manifest source.
- [`apps/pi-mom/.env.example`](../apps/pi-mom/.env.example) — placeholder-only local env shape.
- [`apps/pi-mom/.env.railway.example`](../apps/pi-mom/.env.railway.example) — placeholder-only Railway env shape.

### Specs

- [`docs/specs/registry-yaml-schema.md`](specs/registry-yaml-schema.md) — historical/deprecated registry format note; live routes are in `apps/pi-mom/lib/routes.mjs`.
- [`docs/specs/context7-pi-agent-harness-spec.md`](specs/context7-pi-agent-harness-spec.md) — Context7 Pi harness design.
- [`docs/specs/covent-slack-pi-harness.md`](specs/covent-slack-pi-harness.md) — older Slack MCP bearer-token harness spec; historical/staged.

### Source-of-truth / product operating model

- [`docs/source-of-truth/COVENT_OPERATING_SOURCE_OF_TRUTH_V0.md`](source-of-truth/COVENT_OPERATING_SOURCE_OF_TRUTH_V0.md) — strategic operating model; still contains draft-era language, so prefer this index for current system boundaries.
- [`docs/source-of-truth/DISTRIBUTION_AGENT_LOOP_SOURCE_OF_TRUTH.md`](source-of-truth/DISTRIBUTION_AGENT_LOOP_SOURCE_OF_TRUTH.md) — historical Distribution-agent context; useful evidence, not live instruction.

### Runbooks

- [`docs/runbooks/covent-slack-mcp-setup.md`](runbooks/covent-slack-mcp-setup.md) — current Slack MCP OAuth/safety runbook.
- [`docs/runbooks/covent-pi-mom-known-good.md`](runbooks/covent-pi-mom-known-good.md) — historical known-good notes from the pre-rebuild era; reference the post-rebuild architecture in `docs/architecture.md` instead.
- [`docs/runbooks/branch-protection.md`](runbooks/branch-protection.md) — main-branch protection rules.

### ADRs

- [`docs/adr/0001-slack-app-mention-primary-ux.md`](adr/0001-slack-app-mention-primary-ux.md)
- [`docs/adr/0002-linear-is-execution-truth.md`](adr/0002-linear-is-execution-truth.md)
- [`docs/adr/0003-repo-docs-are-canonical-system-truth.md`](adr/0003-repo-docs-are-canonical-system-truth.md)
- [`docs/adr/0004-whimsical-is-visual-map-not-canonical-data-store.md`](adr/0004-whimsical-is-visual-map-not-canonical-data-store.md)

### History/archive

- `docs/history/**` — evidence and recovery context only. Do not treat historical files as current instructions.
- `docs/research/2026-05-10/**` — archived research from the foundation-rebuild scoping pass. Useful for understanding why decisions were made; not authoritative for current state.

### Visual map

- Whimsical board: [Covent Agent OS — Slack/Pi/Linear System Map](https://whimsical.com/covent-agent-os-slack-pi-linear-system-map-FhNbKxykWy2gtzshPe8zoe?ref=mcp).
- The board visualizes this file; this file remains canonical.

## Current pi-mom production behavior

### Active routes

All defined in [`apps/pi-mom/lib/routes.mjs`](../apps/pi-mom/lib/routes.mjs). All Pi-backed routes get the same default-on registered tool surface; route prefixes only shape the workflow instruction.

| Route | Notes |
|---|---|
| `plain` (no prefix) | Full default Pi agent |
| `help` | Canonical menu |
| `status` | Bridge health/config |
| `summarize` | Thread synthesis |
| `linear` | Linear search/comment/create workflow |
| `agenda` | Meeting agenda |
| `spec` | Mirrors to a standalone Slack canvas via canvas-sink |
| `team` | Subagent workflow; team route can add Canvas sidecars for child runs |
| `bash` | Explicit shell workflow |

The Stage-9 image route and the digest:/escalation:/agent:/uictx: routes were deleted in the rebuild.

### Supported primary UX

Inside a relevant Slack thread or the Assistant chat tab:

```text
@Covent-Agent <prompt>                        ← plain route, full default Pi tool surface
@Covent-Agent draft spec                      ← natural-intent → spec: route
@Covent-Agent create Linear issue             ← natural-intent → linear: route
@Covent-Agent team: plan ...                  ← subagent workflow
@Covent-Agent summarize:|linear:|spec:|...    ← explicit prefix routes
@Covent-Agent help | status                   ← built-in bridge commands
```

Fallback/operator route for spec drafts only:

```text
/thread-spec <Slack message/thread URL> [optional focus]
```

`/thread-spec` does not create Linear issues. Use `@Covent-Agent create Linear issue` or `linear:` inside the thread for write-capable Linear behavior.

### Thread context behavior

- Thread root: `event.thread_ts || event.ts`.
- Slack thread fetch: `conversations.replies` with `limit: 12`.
- Sent to Pi prompt: user, timestamp, text (+ route's `systemPromptSuffix`).
- Files, attachments, PDFs, canvases, audio, video: ignored. (Image route was deleted in the rebuild.)

### Linear route behavior (post-rebuild)

- Driven by the modular Linear Pi custom tools (`extensions/linear-tools.ts`): `linear_search_issues`, `linear_create_issue`, `linear_add_comment`.
- Idempotency lives in **model reasoning**, not in a post-stream guard. The model is prompted to ALWAYS call `linear_search_issues` first; if a clear match comes back, prefer `linear_add_comment`; only call `linear_create_issue` if no relevant match exists.
- Default target: Frontend Engineering / `Distribution` / `Backlog` — overridable via `LINEAR_TEAM_ID` / `LINEAR_PROJECT_ID` / `LINEAR_STATE_ID`.
- Requires `LINEAR_API_KEY`. Without it, each tool returns an `isError` AgentToolResult and the model reports the missing key to the user.

## Runtime/deployment truth

Railway production service:

```text
Project/service: covent-pi-mom
Environment:     production
Runtime:         long-running Slack Socket Mode worker (bun 1.3+)
Source branch:   main (auto-deploy on push)
Latest deploy:   commit 1ab169c (2026-05-12)
```

Canary service:

```text
Service:  covent-pi-mom-v2
Status:   down (kept as hot rollback target for ~24h post-cutover)
Restore:  railway up --service covent-pi-mom-v2
```

Useful commands from repo root:

```bash
bun run check                                     # secret-scan + validators + pi-mom tests + tsc --noEmit
bun run doctor:pi-mom                             # non-secret diagnostics

railway service covent-pi-mom
railway status --json | jq '.environments.edges[].node.serviceInstances.edges[] | {svc: .node.serviceName, status: .node.latestDeployment.status, commit: .node.latestDeployment.meta.commitHash[:7]}'
railway logs --service covent-pi-mom
railway variables --service covent-pi-mom --kv | awk -F= '{print $1}' | sort   # keys only; never values
```

Never paste Railway variable values into Slack, Linear, docs, Pi prompts, or git.

Do not paste raw logs without redaction. Logs can contain sensitive context even when trace output is designed to avoid secrets.

## Foundation-v2 cutover evidence (2026-05-12)

- **Merge commit:** `1ab169c` (PR #24, merged 16:01:09 UTC)
- **Stage 10 cleanup:** `a75858f` (legacy delete + plain-route bash + linear-tools typecheck fix)
- **Stage commits preserved in main's history** via `--merge` (not `--squash`); see `git log --oneline 6feda7e..1ab169c` for the 27-commit arc.
- **Net diff:** −4,616 LOC across 76 files (+7,582 / −12,198)
- **FE-554 (Linear)** carries the cutover trail with two comments:
  - `comment-052239bd` — `covent-pi-mom-v2` canary confirmation
  - `comment-a80a5399` — production cutover confirmation

## Known limitations

- Thread context is capped at 12 messages with no pagination.
- App Home cockpit is approvals-only after Stage 10 (runs/activity sections trimmed when `runStore` was deleted; an SDK-backed runs index could re-light them).
- Default-on `bash` lands in the Railway container's ephemeral app runtime; EC2 wiring via `covent-aws-operator` is deferred.
- Slack manifest scopes are still POC-broad and should be reviewed before broader workspace rollout.
- Image generation is permanently removed (Stage 9 killed).

## Required before meaningful changes

1. Read `BOUNDARY.md`.
2. Read `docs/AGENT_CONTEXT.md` and `docs/architecture.md`.
3. Inspect current code for behavior; docs may lag.
4. Run validation before commit/push:

```bash
bun run secret-scan
bun run check
```

5. Link code changes back to the relevant Linear issue.

## Open follow-ups (tracked)

- **Rotate exposed secrets** (`OPENAI_API_KEY`, `LINEAR_API_KEY`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`) — surfaced earlier in `railway variables --kv` dumps; deferred.
- **EC2 wiring via `covent-aws-operator`** — default-on shell/file workflows should land on a real workstation, not the Railway container.
- **Retire `covent-pi-mom-v2` Railway service** after ~24h of prod stability.
- **App Home cockpit re-light** — trimmed to approvals-only when `runStore` was deleted.
