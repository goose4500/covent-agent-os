# Migration map

> **Status (2026-05-12):** the one-time bootstrap migration from `~/.pi/agent` is complete. This file is historical evidence of the original copy. The repo is now the canonical source for production Covent Pi work (`covent-pi-mom` deploys from `main` to Railway). New work should land in the repo via PR, not via local edits to `~/.pi/agent`.

## Original bootstrap (one-time)

This repo was bootstrapped from the local Covent/Pi automation state on Jake's workstation. The mapping below records that initial copy.

| Old local path | New repo path | Notes |
|---|---|---|
| `/home/jfloyd/.pi/agent/pi-mom/` | `apps/pi-mom/` | Slack ↔ Pi bridge. Excludes local `.slack` state, deps, logs, env. |
| `/home/jfloyd/.pi/agent/extensions/` | `extensions/` | Pi tools/guards. `env-guard.ts` copied from symlink target. |
| `/home/jfloyd/.pi/agent/lib/` | `lib/` | Shared runtime helpers (most logic since moved into `apps/pi-mom/lib/` during the foundation rebuild). |
| `/home/jfloyd/.pi/agent/agents/` | `agents/` | Local subagent definitions. |
| `/home/jfloyd/.agents/linear-*.md` | `agents/` | User-level Linear auditor agents used in Covent work. |
| `/home/jfloyd/.pi/agent/skills/` | `skills/` | Current local Pi skills. |
| `/home/jfloyd/.agents/skills/*` | `skills/` when missing | Missing user-level skills added without overwriting local Pi versions. |
| `/home/jfloyd/.pi/agent/packages/pi-chrome-access/` | `packages/pi-chrome-access/` | Chrome/DevTools browser access package. |
| `/home/jfloyd/.pi/agent/docs/*.md` | `docs/runbooks/`, `docs/specs/` | Selected sanitized runbooks/specs. |
| `/home/jfloyd/covent-source/*SOURCE_OF_TRUTH*.md` | `docs/source-of-truth/` | Sanitized source-of-truth docs only. |
| `/home/jfloyd/pi-session-audit/2026-05-07/final-context-pack.md` | `docs/history/pi-session-context-2026-05-07.md` | Context summary; raw transcripts excluded. |

## Intentionally excluded

- Real env files and secrets.
- `node_modules/`.
- `.slack/apps.json`, `.slack/config.json`, `.slack/cache/`.
- Pi sessions/transcripts/raw JSONL.
- Logs, pidfiles, generated images, browser profiles/cookies.

## Post-bootstrap evolution

After the initial copy, substantial changes landed in the repo and are not reflected back in `~/.pi/agent`:

- **Foundation rebuild (Stages 0–10, May 5–12, 2026):** subprocess `spawn("pi", …)` → in-process Pi SDK via `@earendil-works/pi-coding-agent@0.74`. See `docs/architecture.md` and `docs/runbooks/foundation-v2-cutover-2026-05-12.md`.
- **Per-Action registry:** `apps/pi-mom/control-plane/registry.yaml` is now the single source of truth for routes/tools/approvals. See `docs/specs/registry-yaml-schema.md`.
- **Modular Linear custom tools:** `extensions/linear-tools.ts` replaced the older `lib/linear-idempotency.mjs` post-stream guard with 3 composable model-callable tools.
- **Deleted entirely:** image-generation route, `digest:`/`escalation:` routes, `agent:` route + Block Kit Run Cards, the entire `runStore` + `agent-runners` plumbing, `splitForSlackStream`. Net `−4,616 LOC` across 76 files.

If you have a working `~/.pi/agent/pi-mom/` snapshot from before the rebuild, it is **not** safe to copy back into the repo; the architectures have diverged.

## When this file matters

- Reading a vault session log from April 2026 that mentions `~/.pi/agent/pi-mom/index.mjs` and wondering where that lives today → here.
- Recovering an artifact that was sanitized out during the bootstrap → here.
- Planning a similar bootstrap for another client's `~/.pi/agent` state → use this as a template; the "intentionally excluded" list above is the high-leverage part.
