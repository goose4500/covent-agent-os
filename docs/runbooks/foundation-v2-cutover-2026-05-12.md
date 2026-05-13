# Foundation-v2 cutover runbook (2026-05-12)

> Records the lifecycle that took `covent-pi-mom` from a broken pre-rebuild state on `main` to a working post-rebuild state, also on `main`, via a parallel canary service. Reusable as the canonical blue-green pattern for future risky Railway migrations.

## Context

The pre-rebuild bridge spawned `pi` as a subprocess (`spawn("pi", …)`). On Railway, `node_modules/.bin/pi` isn't on the runtime PATH → ENOENT on every Slack mention. The bot had never worked end-to-end in production. We rebuilt the foundation on three primitives over an 8-day arc on a `foundation-v2` branch (Stages 0–10), then cut over to `main`.

## Topology used during the cutover

```
                         GitHub
              ┌──────────────────────────┐
              │   main branch            │   ◄── frozen during rebuild; auto-deploys covent-pi-mom
              │   foundation-v2 branch   │   ◄── all rebuild work; auto-deploys covent-pi-mom-v2
              └──────────────────────────┘
                       │           │
              auto-deploys │           │ auto-deploys
                       ▼           ▼
              ┌──────────────────────────┐
              │   Railway project        │
              │                          │
              │   covent-pi-mom          │   ◄── PROD, broken (ENOENT on every mention)
              │   covent-pi-mom-v2       │   ◄── CANARY, rebuild branch
              └──────────────────────────┘
```

Both services share the same Slack tokens. Only one can hold the Socket Mode connection at a time, so the canary effectively becomes the "real" bot during the rebuild while broken prod sits idle.

## The cutover sequence (executed 2026-05-12)

### Phase 1 — Pre-flight

1. **Confirm canary green.** Live-fire 4 canaries on `covent-pi-mom-v2`: plain+bash, linear:, bash:, and one extra. Each must return real container output (verified via `hostname` in the response).
2. **Env diff between canary and prod:**
   ```bash
   railway service covent-pi-mom-v2
   railway variables --kv | awk -F= '{print $1}' | sort > /tmp/v2.keys

   railway service covent-pi-mom
   railway variables --kv | awk -F= '{print $1}' | sort > /tmp/prod.keys

   comm -23 /tmp/v2.keys /tmp/prod.keys   # keys in v2 but not in prod
   ```
   Identified missing on prod: `LINEAR_TEAM_ID`, `LINEAR_PROJECT_ID`, `LINEAR_STATE_ID`, `PI_AUTH_JSON_B64`, `PI_AGENT_DIR`, `PI_OFFLINE`.

### Phase 2 — Env mirror (values never echo)

One-liner pipes v2's values straight to prod via shell variables; no terminal output of secret contents:

```bash
railway variables --service covent-pi-mom-v2 --kv | \
  grep -E '^(LINEAR_TEAM_ID|LINEAR_PROJECT_ID|LINEAR_STATE_ID|PI_AUTH_JSON_B64|PI_AGENT_DIR|PI_OFFLINE)=' | \
  while IFS='=' read -r k v; do
    echo "mirror $k (len ${#v})"
    railway variable set --service covent-pi-mom "$k=$v" >/dev/null && echo "  -> set on prod"
  done
```

Verify the mirror via keys-only enumeration (still no values):

```bash
railway variables --service covent-pi-mom --kv | awk -F= '{print $1}' | sort
```

### Phase 3 — Down the canary

**CRITICAL.** Two services with the same Slack tokens = Socket Mode split-brain. Slack rotates between them randomly; events get dropped or duplicated.

```bash
railway service covent-pi-mom-v2
railway down --yes
```

Confirm via logs: expect a `signal SIGTERM` line in the canary's last entries.

### Phase 4 — Merge

Preserve stage commit history with `--merge` (not `--squash`):

```bash
gh pr merge 24 --merge
```

Verify:

```bash
gh pr view 24 --json state,mergeCommit
# expect: {"state": "MERGED", "mergeCommit": {"oid": "1ab169cb..."}}
```

### Phase 5 — Watch prod redeploy

Railway picks up the main update and starts building:

```bash
railway service covent-pi-mom

# Poll until SUCCESS or FAILED
prev=""
while :; do
  s=$(railway status --json | jq -r '.environments.edges[].node.serviceInstances.edges[] | select(.node.serviceName=="covent-pi-mom") | .node.latestDeployment.status')
  if [ "$s" != "$prev" ]; then
    echo "[$(date -u +%H:%M:%S)] prod deploy status: $s"
    prev="$s"
  fi
  case "$s" in SUCCESS|FAILED|CRASHED|REMOVED) break ;; esac
  sleep 8
done
```

Typical sequence: `BUILDING` → `DEPLOYING` → `SUCCESS` in 3–5 min.

### Phase 6 — Boot signature verification

```bash
railway logs --service covent-pi-mom | tail -20
```

Expected lines in the new code's boot output:

- `$ bun index.mjs` (not `> node index.mjs` — that's old code)
- `✓ Seeded /data/pi-agent/auth.json from PI_AUTH_JSON_B64 (<N> bytes)`
- `🔑 Bot auth: covent_pi (U0B0VJJDKFH) on Covent`
- `Slack streaming: enabled (slack-sink + heartbeat)`
- **No** `Agent route: enabled` line (deleted in Stage 10)
- **No** `Image route: disabled` line (image-gen ripped)

If any of the deleted lines appear, the cached build was deployed instead of the new code. Trigger an explicit redeploy or push a noop commit.

### Phase 7 — Live canary on prod

Run two tests in the allowed Slack test channel (`#idea-specs`):

1. **Plain + bash:** `@Covent-Agent use your bash tool to run \`uname -a && uptime && hostname && pwd\` and report the exact output.`
   - Expect: `toolCount: 6` in logs, real container output in Slack reply.
   - **Key marker:** the `hostname` value should be different from the canary's last-seen hostname. This proves the response came from the new prod container, not a stale canary cache.

2. **Linear:** `@Covent-Agent linear: add a one-line note confirming production cutover. Note: …`
   - Expect: `toolCount: 3`, `route: linear`, model chains `linear_search_issues` → `linear_add_comment`. Final reply contains the Linear comment URL.

### Phase 8 — Post-cutover housekeeping

```bash
# Delete the merged branch on GitHub
gh api -X DELETE repos/goose4500/covent-agent-os/git/refs/heads/foundation-v2
# Verify
gh api repos/goose4500/covent-agent-os/git/refs/heads/foundation-v2 2>&1 | head -3
# (expect a "Not Found" 404)

# Optional: cosmetic env cleanup on prod
for k in PI_COMMAND PI_EXTRA_ARGS PI_OUTPUT_IDLE_MS PI_MOM_ALLOW_PI_TOOLS PI_MOM_IMAGE_ROUTE_ENABLED PI_MOM_STREAMING; do
  railway variable delete --service covent-pi-mom "$k"
done
```

### Phase 9 — Hold the canary for ~24h

Don't delete `covent-pi-mom-v2` yet. It's a hot rollback target. `railway up --service covent-pi-mom-v2` restores it within ~2 minutes. After prod is stable for the rollback window, delete the canary service.

## Reusable pattern checklist

For any future risky Railway migration that follows this shape:

- [ ] Cut a long-lived feature branch off main; freeze main during the work.
- [ ] Provision a second Railway service in the same project, point at the feature branch, mirror initial env.
- [ ] Iterate stages on the canary; each stage lands on the canary continuously.
- [ ] Pre-merge: env diff + mirror missing keys (stdin-pipe, values never echo).
- [ ] Pre-merge: `railway down --service <canary> --yes`.
- [ ] Merge with `--merge` (not `--squash`) to preserve stage history.
- [ ] Watch Railway via `railway status --json | jq …` for `BUILDING → DEPLOYING → SUCCESS`.
- [ ] Boot signature verification before live canary.
- [ ] Live canary on prod with a distinguishing marker (hostname) to prove real prod execution.
- [ ] Hold canary `down` for ~24h, then delete.
- [ ] Delete merged feature branch on GitHub.
- [ ] Optional: cosmetic env cleanup of dead vars.

## Failure modes and recovery

| Failure | Cause | Recovery |
|---|---|---|
| Prod boots with cached old image | Railway build cache served stale layers | Trigger explicit redeploy or push noop commit |
| Prod deploys but missing env crashes it | Env diff missed a key | `railway up --service covent-pi-mom-v2` to restore canary; mirror remaining keys; redeploy prod |
| Split-brain Slack events | Both services up with same tokens | Down whichever you don't want as primary — usually canary |
| Boot signature shows old code lines | Build picked up wrong commit (e.g. push didn't actually update main) | `git log origin/main --oneline -1` to confirm; force-fetch + retry |
| Linear / Pi tools `isError` | New env vars not actually set (typo in mirror script) | Re-run mirror script; verify with keys-only enumeration |

## Evidence trail (this cutover)

- Merge commit: `1ab169c` (PR #24, merged 2026-05-12 16:01:09 UTC)
- Stage 10 cleanup commit: `a75858f`
- Build started: ~16:01:23 UTC
- Build finished: ~16:03:45 UTC (status `SUCCESS`)
- Prod canary test 1 (plain + bash): `req_mp2tmdvx`, 8.4s, hostname `f4324a18eef9`
- Prod canary test 2 (linear:): `req_mp2tn770`, 24s, [comment-a80a5399](https://linear.app/dispo-genius/issue/FE-554/.../#comment-a80a5399)
- v2 canary test 2 (pre-merge baseline): hostname `2e15355e4110` — different from prod, confirming canary→prod was a real container switch, not a stale response.

## Related

- [`docs/architecture.md`](../architecture.md) — the post-rebuild architecture this cutover delivered.
- [`docs/SYSTEM_INDEX.md`](../SYSTEM_INDEX.md) — system-wide source-of-truth map.
- [`docs/AGENT_CONTEXT.md`](../AGENT_CONTEXT.md) — read-first agent context.
- [`docs/specs/registry-yaml-schema.md`](../specs/registry-yaml-schema.md) — the declarative file the rebuild centered on.
- Vault session log (Jake's Obsidian): `Daily/sessions/2026-05-12-covent-agent-os-foundation-rebuild-shipped.md`
- Vault pattern (Jake's Obsidian): `07_Solutions/patterns/pattern-railway-canary-blue-green.md`
