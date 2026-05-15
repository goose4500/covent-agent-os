# Local DX

## Goals

- One repo contains Covent automation source.
- Local DX stays fast: edit repo → run checks → run the Slack bridge → test in `#idea-specs`.
- `~/.pi/agent` is runtime/install state for the standalone `pi` CLI. Parent Pi runs are in-process via the SDK, and default-on team/subagent workflows spawn child `pi` CLI runs, so local/prod runtimes need `pi` on PATH.

## Common commands

```bash
bun install                    # workspace install
bun run check                  # secret-scan + skill/agent validators + pi-mom tests + tsc --noEmit
bun run doctor                 # alias for doctor:pi-mom
bun run doctor:pi-mom          # non-secret readiness diagnostics
bun run dev:pi-mom             # run the Slack bridge locally
bun run install:pi             # required if pi is not already on PATH; team/subagent child runs use it
bun run typecheck              # tsc --noEmit
bun run secret-scan            # scripts/secret-scan.sh (gitleaks + rg patterns)
```

`npm` works in compat mode via bun, but the canonical runtime is **bun 1.3+**. The package.json's `"engines": {"bun": ">=1.3.0"}` field is the source of truth.

## Source layout

- `apps/pi-mom/` — the Slack Socket Mode bridge (deployed to Railway as `covent-pi-mom`).
- `apps/pi-mom/lib/routes.mjs` — route labels/instructions/help/status; prefixes shape workflow, not tool access.
- `apps/pi-mom/lib/` — dispatch, routes, pi-sdk-runner, pi-session, slack-sink, slack-ui-context, canvas-sink, subagent sidecar sink, composite-sink, thread-session-map, home-view.
- `extensions/` — default-on Pi extension tools (`linear-tools.ts`, `slack-interactive-tools.ts`, `browser-use-tools.ts`, `git-checkpoint.ts`).
- `lib/` — shared JavaScript helpers (legacy; most logic now in `apps/pi-mom/lib/`).
- `skills/` — Pi skills.
- `agents/` — subagent definitions.
- `docs/` — architecture, ADRs, runbooks, specs, source-of-truth notes, historical research.

## Local Slack testing

1. Fill `apps/pi-mom/.env.local` with your Slack tokens (never commit). See `apps/pi-mom/README.md` for the full env shape and 1Password recipe.
2. Run `bun run dev:pi-mom`.
3. Confirm prod isn't also handling the same Slack tokens (both services holding the same Socket Mode connection causes split-brain).
4. Mention `@Covent-Agent` in `#idea-specs` from your Slack account. Watch logs for `[pi-mom-trace]` lines.

If Pi credentials aren't seeded locally (`~/.pi/agent/auth.json`), the SDK will prompt for OAuth on first session creation. Either log in once interactively, or set `PI_AUTH_JSON_B64` from a sibling environment's auth.json.

## Syncing from `~/.pi/agent` (historical)

The repo was originally bootstrapped by copying state from `~/.pi/agent/pi-mom/`. That migration is complete; `MIGRATION_MAP.md` documents the one-time copy. The sync scripts under `scripts/` are kept for evidence but should not be re-run — this repo is now the canonical source.

## Production deploy

Production runs on Railway. The bridge auto-deploys from `main`. See [`README.md`](README.md) and [`docs/runbooks/foundation-v2-cutover-2026-05-12.md`](docs/runbooks/foundation-v2-cutover-2026-05-12.md) for the deploy lifecycle.

Do not run `bun run dev:pi-mom` locally against production Slack tokens unless you intentionally want a local instance to hold the Socket Mode connection (which kicks the Railway worker off).
