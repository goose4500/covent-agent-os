# covent-agent-os

Private monorepo for Covent's AI automation operating layer — the Slack ↔ Pi (AI coding agent) bridge plus the Pi extensions, skills, and runbooks that back it.

> **Production status (2026-05-12):** `covent-pi-mom` (the Slack bridge) is **live in production on Railway**. Foundation rebuilt on `foundation-v2`, merged to `main` as commit `1ab169c` via PR #24. The bot does work end-to-end for the first time since the project started. See [docs/architecture.md](docs/architecture.md) for the post-rebuild architecture and [docs/runbooks/foundation-v2-cutover-2026-05-12.md](docs/runbooks/foundation-v2-cutover-2026-05-12.md) for the cutover lifecycle.

## What this repo is

- **Slack bridge runtime**: `apps/pi-mom/` — Bolt 4.7 Assistant container + `app_mention` parity, surfaces Pi agent execution into Slack threads.
- **Pi agent layer**: `extensions/`, `skills/`, `agents/`, `packages/` — Pi custom tools (Linear, permission-gate, env-guard, browser access) and reusable operating modes.
- **Control plane**: `apps/pi-mom/control-plane/registry.yaml` — single declarative file for routes, per-Action tool gating, system-prompt suffixes, and approval posture.
- **Operating docs**: `docs/` — architecture, ADRs, runbooks, specs, source-of-truth, and historical research.

## Three primitives

The bridge is wired on three primitives. Nothing bespoke duplicates what they already do.

| Primitive | What it is |
|---|---|
| [`@earendil-works/pi-coding-agent@0.74`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | Pi SDK, **embedded in-process** via `createAgentSession` + `SessionManager` + `setActiveToolsByName`. No subprocess. |
| [`@slack/bolt@4.7`](https://slack.dev/bolt-js/) + [`@slack/web-api@7.15.2`](https://slack.dev/node-slack-sdk/web-api) | Slack runtime. `Assistant` container + `app_mention` adapter share one `dispatchToAction`. `chat.startStream` + `canvases.{create,edit}`. |
| `apps/pi-mom/control-plane/registry.yaml` | Per-route declarative config. Dispatcher + SDK runner read the same file. |

Runtime: **bun 1.3+**.

## Quick start

```bash
bun install
bun run check          # secret-scan + skill/agent validators + pi-mom test suites + tsc --noEmit
bun run doctor:pi-mom  # non-secret readiness diagnostics
```

To run the Slack bridge locally:

```bash
# Fill apps/pi-mom/.env.local from your secret manager; never commit
cp apps/pi-mom/.env.example apps/pi-mom/.env.local
bun run dev:pi-mom
```

If you also need a local Pi install for harness experimentation:

```bash
bun run install:pi
```

## Agent Actions — team-facing model

Engineers ask `@Covent-Agent` for outcomes; the bot resolves the message to an **Action** with bounded tools.

```text
Covent Agent = the Slack app engineers use
Actions      = bounded things it can do (defined in registry.yaml)
Runs         = one execution of an Action
Approvals    = Slack modals before risky tool calls (e.g. rm -rf via permission-gate)
Artifacts    = source-linked results: Slack thread + optional canvas + Linear comment/issue
```

Core loop:

```text
Slack mention → dispatchToAction → action-resolver(registry.yaml) → runTurn(session, sink) → stream + tools → result
```

Active routes (`apps/pi-mom/control-plane/registry.yaml`):

| Route | tools active | What it does |
|---|---|---|
| `plain` (no prefix) | `bash` + `read` + `grep` + `find` + `edit` + `write` | Full default Pi toolset — bare mentions can do real work |
| `help` | — | Hard-coded menu |
| `status` | — | Bridge health/config |
| `summarize` | — | Thread → decisions/questions/owners |
| `linear` | `linear_search_issues` + `linear_create_issue` + `linear_add_comment` | Search-first idempotency → comment-or-create |
| `agenda` | — | Thread → meeting agenda |
| `spec` | — | Thread → PRD draft (mirrors to a Slack canvas via canvas-sink) |
| `bash` | `bash` | Explicit shell; `permission-gate` intercepts `rm -rf` / `sudo` / `chmod 777` / `chown 777` |

## Production deploy

The production Slack bot runs as a Railway service:

```text
Project:     covent-pi-mom
Environment: production
Service:     covent-pi-mom        (auto-deploy from main)
Canary:      covent-pi-mom-v2     (currently `down`; hot rollback target for ~24h post-cutover)
Runtime:     long-running Socket Mode worker (no public ingress)
```

Required env vars (Railway Variables, never in git):

```text
SLACK_BOT_TOKEN          xoxb-...    Bot User OAuth Token
SLACK_APP_TOKEN          xapp-...    App-Level Token (connections:write)
SLACK_ALLOWED_CHANNEL_ID C0B05VBGJKF #idea-specs channel guard
SLACK_TEST_CHANNEL_NAME  idea-specs
EXPECTED_SLACK_BOT_USER  covent_pi   Identity guard (wrong-workspace token catch)

PI_MOM_MODE=pi                     echo | pi
PI_MOM_MODEL                       openai-codex/gpt-5.5
PI_MOM_THINKING_LEVEL              high
PI_MOM_TRACE                       true
PI_TIMEOUT_MS                      180000   wall-clock per Pi run
PI_OFFLINE                         1        no SDK auto-npm-install
PI_AUTH_JSON_B64                   base64(~/.pi/agent/auth.json) — seeded on cold boot
PI_AGENT_DIR                       /data/pi-agent   persistent volume

OPENAI_API_KEY                     sk-...
LINEAR_API_KEY                     lin_api_...
LINEAR_TEAM_ID                     UUID — Frontend Engineering
LINEAR_PROJECT_ID                  UUID — Distribution
LINEAR_STATE_ID                    UUID — Backlog

MAX_SLACK_TEXT                     38000
```

Useful commands from repo root:

```bash
railway service covent-pi-mom
railway status --json | jq '.environments.edges[].node.serviceInstances.edges[] | {svc: .node.serviceName, status: .node.latestDeployment.status, commit: .node.latestDeployment.meta.commitHash[:7]}'
railway logs --service covent-pi-mom
railway variables --service covent-pi-mom --kv | awk -F= '{print $1}' | sort   # keys only; never paste values
```

Deploys are triggered by pushes to `main`. Do **not** `railway up` from a local checkout unless you're intentionally deploying ahead of the auto-deploy.

## System map

Start here:

- [`docs/architecture.md`](docs/architecture.md) — canonical post-rebuild architecture (the file tree, route table, env vars, extensions, deploy lifecycle).
- [`docs/SYSTEM_INDEX.md`](docs/SYSTEM_INDEX.md) — system-wide source-of-truth map across Slack, Pi, Linear, Git, Railway, Whimsical.
- [`docs/AGENT_CONTEXT.md`](docs/AGENT_CONTEXT.md) — read-first operating context for future agents.
- [`BOUNDARY.md`](BOUNDARY.md) and [`SECURITY.md`](SECURITY.md) — authority and secret-handling rules.
- [`docs/runbooks/foundation-v2-cutover-2026-05-12.md`](docs/runbooks/foundation-v2-cutover-2026-05-12.md) — the cutover lifecycle (also the reusable pattern for future blue-green Railway migrations).

## Operating spine

```text
Slack    = cockpit / intake / approvals
Pi SDK   = reasoning + execution runtime (in-process under bun)
registry = single source of truth for routes/tools/approvals
Linear   = execution truth (issues + comments) via modular Pi custom tools
GitHub   = code truth
Railway  = runtime/deployment state
Docs     = canonical system memory (this folder)
```

Read `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `BOUNDARY.md`, and `SECURITY.md` before adding write-capable automation.
