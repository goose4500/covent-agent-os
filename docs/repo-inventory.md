# Repo inventory

> **Status (2026-05-12):** post-foundation-rebuild inventory. `covent-pi-mom` is live in production. See `docs/architecture.md` for the canonical post-rebuild architecture.

## What's in this repo

### Top-level

- `README.md` — repo overview + quick start + production deploy table.
- `BOUNDARY.md` — authority model + mutation boundaries.
- `SECURITY.md` — secret handling.
- `LOCAL_DX.md` — local development commands.
- `MIGRATION_MAP.md` — historical bootstrap evidence (the `~/.pi/agent` → repo copy).

### `apps/pi-mom/` — the Slack bridge (production)

- `index.mjs` (~799 LOC) — Bolt boot, both surface adapters (Assistant + app_mention), App Home wiring.
- `control-plane/registry.yaml` — declarative per-Action vocabulary.
- `control-plane/registry-loader.mjs` — YAML loader + validator.
- `lib/dispatch.mjs` — surface-aware `dispatchToAction`.
- `lib/action-resolver.mjs` — parses Slack text + registry → resolved Action.
- `lib/pi-sdk-runner.mjs` — `createAgentSession` glue; OAuth seed from `PI_AUTH_JSON_B64`.
- `lib/pi-session.mjs` — `runTurn` — opens session, subscribes events, pumps sink.
- `lib/thread-session-map.mjs` — JSON-on-disk threadTs → sessionFile path.
- `lib/slack-sink.mjs` — Pi events → `chat.startStream/appendStream` + 25s heartbeat + per-message rotation.
- `lib/slack-ui-context.mjs` — Pi `ExtensionUIContext` → Slack approval modals.
- `lib/canvas-sink.mjs` — Pi `text_delta` → `canvases.edit` (debounced) for `spec:` route.
- `lib/composite-sink.mjs` — fan one Pi event stream → multiple sinks.
- `lib/home-view.mjs` — App Home cockpit view builder (approvals-only after Stage 10).
- `doctor.mjs` — non-secret readiness diagnostics.
- `manifest.yaml` — Slack app manifest source.
- `.env.example`, `.env.railway.example` — placeholder env shapes.
- 13 `test-*.mjs` suites runnable via `bun run check`.

### `extensions/` — Pi extensions

- `linear-tools.ts` — 3 modular Linear Pi custom tools (`linear_search_issues`, `linear_create_issue`, `linear_add_comment`).
- `permission-gate.ts` — intercepts `rm -rf` / `sudo` / `chmod 777` / `chown 777` via Slack approval modal.
- `env-guard.ts` — blocks writes to `.env*` / `~/.secrets/**`.
- `git-checkpoint.ts` — auto-commits before risky operations.
- `linear-mcp-guard.ts`, `slack-mcp-guard.ts` — MCP boundary guards.
- `browser-use-tools.ts` — Chrome/DevTools harness.

### `lib/` — Shared helpers

Legacy shared helpers from the bootstrap; most production logic has since moved into `apps/pi-mom/lib/`.

### `agents/` and `skills/`

Subagent definitions and Pi skills. Used by harness-level tooling, not directly by `apps/pi-mom`.

### `packages/`

- `pi-chrome-access/` — Chrome/DevTools Pi package.
- `pi-ext-covent-aws/` — EC2 operator extension scaffolding (not yet wired into production).

### `docs/`

- `architecture.md` — **canonical post-rebuild architecture.**
- `SYSTEM_INDEX.md` — system-wide source-of-truth map.
- `AGENT_CONTEXT.md` — read-first context for future agents.
- `adr/` — architecture decision records (0001–0004).
- `runbooks/` — operational runbooks (foundation-v2 cutover, Slack MCP setup, EC2 Pi agent machine, branch protection, historical known-good).
- `specs/` — design specs (registry.yaml schema, Pi harness specs).
- `source-of-truth/` — strategic operating-model docs.
- `history/` — evidence/recovery context only.
- `research/2026-05-10/` — archived foundation-rebuild scoping research.

### `scripts/`

- `secret-scan.sh` — pre-commit secret scan (gitleaks + rg patterns).
- `validate-skills.mjs`, `validate-agents.mjs` — frontmatter validators.
- `scaffold-agent.mjs` — agent scaffolder.
- `install-local.sh` — install repo as a Pi package for local harness experiments.
- `sync-from-live-pi.sh` — **historical** one-time migration script; do not re-run.

## Excluded

- Real env files and secrets.
- `node_modules/`.
- `.slack/apps.json`, `.slack/config.json`, `.slack/cache/`.
- Pi sessions/transcripts/raw JSONL.
- Logs, pidfiles, generated images, browser profiles/cookies.

See `MIGRATION_MAP.md` and `.gitignore`.
