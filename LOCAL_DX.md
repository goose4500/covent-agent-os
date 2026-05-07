# Local DX

## Goals

- One repo contains Covent automation source.
- `~/.pi/agent` becomes runtime/install state, not source of truth.
- Local POC stays fast: edit repo → run checks → install/load in Pi → test Slack route.

## Common commands

```bash
npm install
npm run check
npm run doctor
npm run dev:pi-mom
npm run install:pi
```

## Source layout

- `apps/pi-mom/` — live Slack Socket Mode bridge.
- `extensions/` — Pi extension tools and guards.
- `lib/` — shared JavaScript helpers.
- `skills/` — Pi skills copied from current local working state.
- `agents/` — subagent definitions copied from current local working state.
- `packages/pi-chrome-access/` — local Chrome/DevTools Pi package.
- `docs/` — runbooks, specs, source-of-truth notes, context packs.

## Syncing from current live Pi state

Use this only while migrating:

```bash
scripts/sync-from-live-pi.sh --dry-run
scripts/sync-from-live-pi.sh --apply
```

The goal is to retire ad-hoc edits in `~/.pi/agent` and make this repo canonical.
