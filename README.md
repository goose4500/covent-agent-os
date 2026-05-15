# covent-agent-os

Private monorepo for Covent's AI automation operating layer — the Slack ↔ Pi (AI coding agent) bridge plus the Pi extensions, skills, and runbooks that back it.

> **Production status (2026-05-12):** `covent-pi-mom` (the Slack bridge) is **live in production on Railway**. Foundation rebuilt on `foundation-v2`, merged to `main` as commit `1ab169c` via PR #24. The bot does work end-to-end for the first time since the project started. See [docs/architecture.md](docs/architecture.md) for the post-rebuild architecture and [docs/runbooks/foundation-v2-cutover-2026-05-12.md](docs/runbooks/foundation-v2-cutover-2026-05-12.md) for the cutover lifecycle.

## What this repo is

- **Slack bridge runtime**: `apps/pi-mom/` — Bolt 4.7 Assistant container + `app_mention` parity, surfaces Pi agent execution into Slack threads.
- **Pi agent layer**: `extensions/`, `skills/`, `agents/`, `packages/` — Pi custom tools (Linear, Slack UI, Browser Use, git checkpoint, web access) and reusable operating modes.
- **Route control**: `apps/pi-mom/lib/routes.mjs` — pure route catalog for workflow instructions plus Slack help/status text. Tool/skill/extension access is default-on for Pi-backed routes.
- **Operating docs**: `docs/` — architecture, ADRs, runbooks, specs, source-of-truth, and historical research.

## Three primitives

The bridge is wired on three primitives. Nothing bespoke duplicates what they already do.

| Primitive | What it is |
|---|---|
| [`@earendil-works/pi-coding-agent@0.74`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | Pi SDK, **embedded in-process** for parent runs via `createAgentSession` + `SessionManager` + `setActiveToolsByName`. Child subagents may spawn the `pi` CLI. |
| [`@slack/bolt@4.7`](https://slack.dev/bolt-js/) + [`@slack/web-api@7.15.2`](https://slack.dev/node-slack-sdk/web-api) | Slack runtime. `Assistant` container + `app_mention` adapter share one `dispatchToAction`. `chat.startStream` + `canvases.{create,edit}`. |
| `apps/pi-mom/lib/routes.mjs` | Route catalog. Dispatcher/help/status/tests read the same route labels and workflow instructions. |

Runtime: **bun 1.3+**.

## Quick start

```bash
bun install
bun run install:pi     # required for default-on team/subagent child runs
bun run check          # secret-scan + skill/agent validators + pi-mom test suites + tsc --noEmit
bun run doctor:pi-mom  # non-secret readiness diagnostics; verifies pi CLI availability
```

To run the Slack bridge locally:

```bash
# Fill apps/pi-mom/.env.local from your secret manager; never commit
cp apps/pi-mom/.env.example apps/pi-mom/.env.local
bun run dev:pi-mom
```

If your machine does not already have Pi on PATH:

```bash
bun run install:pi
```

## Agent Actions — team-facing model

Engineers ask `@Covent-Agent` for outcomes; the bot resolves the message to an **Action** that shapes the workflow while keeping Pi's registered tools/skills/extensions available by default.

```text
Covent Agent = the Slack app engineers use
Actions      = workflow intents/prefixes (defined in lib/routes.mjs)
Runs         = one execution of an Action
Approvals    = explicit Slack/user confirmation when the model or workflow asks for it
Artifacts    = source-linked results: Slack thread + optional canvas + Linear comment/issue
```

Core loop:

```text
Slack mention → dispatchToAction → route instruction(lib/routes.mjs) → runTurn(session, sink) → stream + tools → result
```

Active routes (`apps/pi-mom/lib/routes.mjs`): all Pi-backed routes get the same default-on registered tool surface (`bash`, file tools, Linear tools, Slack UI tools, Browser Use, `pi-subagents`, and `pi-web-access`). Prefixes shape the instruction, not the tool allowlist.

| Route | What it does |
|---|---|
| `plain` (no prefix) | Full default Pi agent |
| `help` | Hard-coded menu |
| `status` | Bridge health/config |
| `summarize` | Thread → decisions/questions/owners |
| `linear` | Linear issue/comment workflow |
| `agenda` | Thread → meeting agenda |
| `spec` | Thread → PRD draft (mirrors to a Slack canvas via canvas-sink) |
| `team` | Team subagent workflow |
| `bash` | Explicit shell route |

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
SLACK_ALLOWED_CHANNEL_ID C0B05VBGJKF,C0B30N60HGW comma-separated channel guard
SLACK_TEST_CHANNEL_NAME  idea-specs
EXPECTED_SLACK_BOT_USER  covent_pi   Identity guard (wrong-workspace token catch)

PI_MOM_MODE=pi                     echo | pi
PI_MOM_MODEL                       openai-codex/gpt-5.5
PI_MOM_THINKING_LEVEL              high
PI_MOM_TRACE                       true
PI_TIMEOUT_MS                      180000   wall-clock per Pi run
PI_OFFLINE                         1        no SDK auto-npm-install
# Subagents and web access are default-on in code; no feature flag required.
PI_ALLOW_BROWSER_COOKIES           0        keep Gemini Web browser cookies off by default
PI_AUTH_JSON_B64                   base64(~/.pi/agent/auth.json) — seeded on cold boot
PI_AGENT_DIR                       /data/pi-agent   persistent volume

OPENAI_API_KEY                     sk-...
EXA_API_KEY / PERPLEXITY_API_KEY / GEMINI_API_KEY optional providers for default-on web tools
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
- [`docs/architecture-diagrams.html`](docs/architecture-diagrams.html) — team-facing single-file visual guide with 10 architecture diagrams.
- [`docs/SYSTEM_INDEX.md`](docs/SYSTEM_INDEX.md) — system-wide source-of-truth map across Slack, Pi, Linear, Git, Railway, Whimsical.
- [`docs/AGENT_CONTEXT.md`](docs/AGENT_CONTEXT.md) — read-first operating context for future agents.
- [`BOUNDARY.md`](BOUNDARY.md) — authority, mutation boundaries, and secret/data-handling rules.
- [`docs/runbooks/foundation-v2-cutover-2026-05-12.md`](docs/runbooks/foundation-v2-cutover-2026-05-12.md) — the cutover lifecycle (also the reusable pattern for future blue-green Railway migrations).

## Operating spine

```text
Slack    = cockpit / intake / approvals
Pi SDK   = reasoning + execution runtime (in-process under bun)
routes   = single source of truth for Slack route instructions/help/status (`apps/pi-mom/lib/routes.mjs`)
Linear   = execution truth (issues + comments) via modular Pi custom tools
GitHub   = code truth
Railway  = runtime/deployment state
Docs     = canonical system memory (this folder)
```

Read `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, and `BOUNDARY.md` before adding write-capable automation.
