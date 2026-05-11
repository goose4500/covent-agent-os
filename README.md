# covent-agent-os

Private development monorepo for Covent's AI automation operating layer.

This repo is the canonical source for the current Slack ↔ Pi automation code, reusable Pi skills/agents, tool extensions, local runbooks, and the path toward production-ready Covent agent workflows.

## What this repo is

- **Slack cockpit/runtime**: `apps/pi-mom/` receives Covent Slack events and routes requests into safe Pi workflows.
- **Pi agent layer**: `skills/`, `agents/`, and `extensions/` define reusable operating modes and bounded tools.
- **Automation tooling**: image generation, MCP guards, permission gates, Chrome/browser access, and context-prime workflows.
- **DX foundation**: doctors, validation scripts, examples, and source-linked docs for local POC work.
- Not production infrastructure yet; this is private POC source control first.

## Quick start

```bash
cd ~/covent-agent-os
npm install
npm run check
npm run doctor
```

## Agent Actions mental model

Covent Agent OS should expose internal AI as **Actions**, not as agents, skills, extensions, routes, or runners.

Team-facing model:

```text
Covent Agent = the Slack app engineers use
Actions = bounded things it can do
Runs = one execution of an Action
Approvals = human gates before risky steps
Artifacts = source-linked results in Slack, GitHub, Linear, or docs
```

Principles:

- Engineers should ask for outcomes, not choose tools.
- Every Action should be explicit, bounded, visible, and source-linked.
- Slack is the cockpit for asking, watching, and approving.
- Pi skills/agents/extensions are implementation details behind the Action.
- The registry should be easy for future AI agents to read and edit in one pass.

Core loop:

```text
Engineer intent → Action → Run card → optional approval → artifact/source links
```

## System map

Start with:

- `docs/SYSTEM_INDEX.md` — canonical map across Slack, Pi, Linear, Git, Railway, Whimsical, and docs.
- `docs/AGENT_CONTEXT.md` — read-first context for future agents.
- `BOUNDARY.md` and `SECURITY.md` — authority and secret-handling rules.

Run the Slack/Pi bridge locally:

```bash
cp apps/pi-mom/.env.example apps/pi-mom/.env.local # fill from secret manager; never commit
npm run dev:pi-mom
```

Install/load as a Pi package locally:

```bash
npm run install:pi
```

## Railway POC worker

Railway is scaffolded as a long-running Socket Mode worker, not a web/serverless function.

```text
Railway project: covent-pi-mom
Environment: production
Service: covent-pi-mom
Start command: npm run dev:pi-mom
```

From the repo root:

```bash
railway status
railway service status
railway variable list --json # verify names/status only; do not paste values
```

Before first deploy, set required startup secrets in Railway Variables only:

```text
SLACK_BOT_TOKEN
SLACK_APP_TOKEN
```

Optional route/runtime secrets:

```text
OPENAI_API_KEY # image route or provider key matching PI_EXTRA_ARGS
LINEAR_API_KEY # required for @Covent Pi create Linear issue
```

Then deploy intentionally:

```bash
railway up --detach
railway logs --service covent-pi-mom
```

## Operating spine

```text
Slack = cockpit / intake / approvals
Pi = reasoning + execution runtime
Skills/agents = reusable operating modes
MCP/tools = bounded capabilities, not authority
Linear/GitHub = durable truth / code truth
Repo docs = canonical system memory
Whimsical = visual map / navigation layer
```

Read `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `BOUNDARY.md`, and `SECURITY.md` before adding write-capable automation.
