# Repo inventory

> **Status (2026-05-15):** current pi-mom inventory. `covent-pi-mom` is live in production. See `docs/architecture.md` for the canonical architecture.

## What's in this repo

### Top-level

- `README.md` — repo overview + quick start + production deploy table.
- `BOUNDARY.md` — authority model, mutation boundaries, and secret/data handling.
- `LOCAL_DX.md` — local development commands.
- `docs/archive/root/migration-map.md` — archived bootstrap evidence (the `~/.pi/agent` → repo copy).

### `apps/pi-mom/` — the Slack bridge (production)

- `index.mjs` — Bolt boot, both surface adapters (Assistant + app_mention), App Home wiring, route resolution.
- `lib/routes.mjs` — route labels/instructions/help/status; prefixes shape workflow, not tool access.
- `lib/dispatch.mjs` — surface-aware `dispatchToAction`.
- `lib/pi-sdk-runner.mjs` — `createAgentSession` glue; OAuth seed from `PI_AUTH_JSON_B64`.
- `lib/pi-session.mjs` — `runTurn` — opens session, subscribes events, pumps sink.
- `lib/thread-session-map.mjs` — JSON-on-disk threadTs → sessionFile path.
- `lib/slack-sink.mjs` — Pi events → `chat.startStream/appendStream` + 25s heartbeat + per-message rotation.
- `lib/slack-ui-context.mjs` — Pi `ExtensionUIContext` → Slack approval modals.
- `lib/canvas-sink.mjs` — Pi `text_delta` → `canvases.edit` (debounced) for `spec:` route.
- `lib/subagent-canvas-sidecar-sink.mjs` — `team:` child subagent runs → sidecar Slack canvases.
- `lib/composite-sink.mjs` — fan one Pi event stream → multiple sinks.
- `lib/home-view.mjs` — App Home cockpit view builder (approvals-only after Stage 10).
- `doctor.mjs` — non-secret readiness diagnostics.
- `manifest.yaml` — Slack app manifest source.
- `.env.example`, `.env.railway.example` — placeholder env shapes.
- `test-*.mjs` suites runnable via `bun run check`.

### `extensions/` — Pi extensions

- `linear-tools.ts` — 3 modular Linear Pi custom tools (`linear_search_issues`, `linear_create_issue`, `linear_add_comment`).
- `slack-interactive-tools.ts` — Slack approval/choice/input cards exposed as Pi tools.
- `browser-use-tools.ts` — Browser Use Cloud task tool.
- `git-checkpoint.ts` — git checkpoint helper tool.

### `lib/` — Shared helpers

Legacy shared helpers from the bootstrap; most production logic has since moved into `apps/pi-mom/lib/`.

### `agents/` and `skills/`

Subagent definitions and Pi skills. `.agents/team-*.md` are used by the default-on Slack `team:` subagent workflow.

### `docs/`

- `architecture.md` — **canonical current architecture.**
- `SYSTEM_INDEX.md` — system-wide source-of-truth map.
- `AGENT_CONTEXT.md` — read-first context for future agents.
- `adr/` — architecture decision records (0001–0004).
- `runbooks/` — active operational runbooks (Slack MCP setup, branch protection).
- `specs/` — active design specs.
- `history/` — evidence/recovery context only.
- `archive/` — archived/superseded docs, research, old runbooks, old specs, and stale skills. Do not use as current instructions.

### `scripts/`

- `install-local.sh` — install repo as a Pi package for local harness experiments.

## Excluded

- Real env files and secrets.
- `node_modules/`.
- `.slack/apps.json`, `.slack/config.json`, `.slack/cache/`.
- Pi sessions/transcripts/raw JSONL.
- Logs, pidfiles, generated images, browser profiles/cookies.

See [`docs/archive/root/migration-map.md`](archive/root/migration-map.md) and `.gitignore`.
