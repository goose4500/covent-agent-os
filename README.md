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
railway variable list --kv
```

Before first deploy, set required secrets in Railway Variables only:

```text
SLACK_BOT_TOKEN
SLACK_APP_TOKEN
OPENAI_API_KEY # or the provider key matching PI_EXTRA_ARGS
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
```

Read `BOUNDARY.md` and `SECURITY.md` before adding write-capable automation.
