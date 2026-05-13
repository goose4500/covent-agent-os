# Event routing

Status: reference
Last updated: 2026-05-13
Related: ADR-0003, issue #48, `docs/runbooks/add-event-source.md`

## Why this exists

Every Pi run used to start from a Slack message. The event-driven runtime lets external systems — Linear today, GitHub and cron next — fire the same routes by handing them a *synthetic Slack message*. One execution path, many trigger sources. Adding a new source is a config change, not a code change.

## Architecture

```text
Linear webhook  ─┐
GitHub webhook  ─┼─▶  Event receiver  ─▶  Destination resolver
Cron tick       ─┤    (sig verify,        (channel + thread_ts)
Internal event  ─┘     dedup, route                │
                       match)                       ▼
                          │              Synthetic Slack msg
                          ▼                        │
                   Trigger ledger  ◀───  pi-sdk-runner (unchanged)
                   (JSONL)                         │
                                                   ▼
                                       Same routes/tools/skills
                                       as a real Slack turn
```

The receiver, resolver, synthetic-message builder, and ledger are each one small file. The route registry stays the single source of truth for behavior.

## The 6 primitives

### 1. HTTP webhook receiver — `apps/pi-mom/event-receiver.mjs`

Mounted on the existing Bolt Express adapter at `POST /webhook/:source`. Per-source HMAC signature verification keyed off env (`LINEAR_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET`, etc). Replay protection via timestamp check. Dedup via bounded in-memory cache. Returns 200 fast, processes async so it never misses a source's response timeout (Linear: 5s; GitHub: 10s). Dependencies (`dispatch`, `appendLedger`, `resolveDestination`) are injected — no direct imports into the receiver — so the unit tests can drive it without booting Bolt.

### 2. Trigger-aware route registry — `apps/pi-mom/control-plane/registry.yaml`

Routes opt into event triggering with an optional `trigger:` block:

```yaml
- name: linear-comment-sync
  trigger:
    source: linear
    when: ["Comment.create"]
    idempotency: webhookDelivery
  destination:
    resolver: linear_attachment_thread
    fallback_channel: C0XXXXXXX
  tools: [linear_graphql, slack_api]
```

Routes without `trigger:` keep working as today (Slack-message-only). Registry validation rejects an unknown `source` or `resolver`.

### 3. Destination resolver — `apps/pi-mom/lib/destination-resolver.mjs`

`resolveDestination(event, route) → {channel, thread_ts?}`. Three strategies, picked per route:

- `linear_attachment_thread` — v1 strategy. Reads the Linear issue's attachments via `linear_graphql`, finds the first attachment whose URL is a Slack permalink, parses out `channel_id` and `thread_ts`.
- `static_mapping` — stubbed for v1. Will key on e.g. `owner/repo` for GitHub.
- `fallback_channel` — last-resort channel defined per route. Used when the strategy returns nothing.

### 4. Synthetic message builder — `apps/pi-mom/lib/synthetic-message.mjs`

`eventToMessage(event, route) → SlackTurnInput`. Packs a compact, human-readable event summary into the turn's text body, tags the source (`linear`, `github`, `cron`, …), sets `user: "-bot"`, and preserves the original event payload as structured context for the model. The `pi-sdk-runner` is unchanged — it just sees a normal turn.

### 5. Approval pattern — existing `permission-gate.ts` + Slack approval modal

Event-fired routes that hit mutation tools default to **draft + confirm**: the agent posts a Block Kit message with the proposed action plus Approve/Cancel buttons; the handler re-enters the same route with `approved: true` on click. Read-only event routes run autonomously. The kill switch is `EVENT_RUNTIME_ENABLED=false` — set it and the receiver short-circuits every delivery to a logged no-op.

### 6. Trigger ledger — `apps/pi-mom/lib/event-ledger.mjs`

Append-only JSONL at `sessions/event-runs.jsonl`:

```json
{"deliveryId":"...","source":"linear","event":"Comment.create","route":"linear-comment-sync","sessionId":"...","status":"completed","startedAt":"...","completedAt":"..."}
```

Answers "did the Linear webhook at 10:42 trigger a run?" without a parallel observability stack.

## End-to-end trace — a Linear comment lands

Second-by-second, what happens the moment a Linear `Comment.create` webhook arrives:

1. **T+0ms** — Linear POSTs to `https://<pi-mom-host>/webhook/linear` with headers `Linear-Signature` (hex HMAC-SHA256 of the raw body) and `Linear-Delivery` (delivery UUID).
2. **T+1ms** — The receiver reads `LINEAR_WEBHOOK_SECRET` from env, computes HMAC-SHA256 over the raw body, constant-time-compares against `Linear-Signature`. Mismatch → 401.
3. **T+2ms** — The receiver checks the body's `webhookTimestamp` against `Date.now()`. Drift > 60s → 401 (replay).
4. **T+3ms** — The receiver constructs the idempotency key `linear:<Linear-Delivery>`. The dedup cache (24h TTL, 10k entries) checks for a hit. Hit → 200 with no-op.
5. **T+4ms** — The receiver matches the event's `type` (`Comment.create`) against the registry's event-triggered routes. `linear-comment-sync` matches.
6. **T+5ms** — Receiver returns **200 OK** to Linear. Processing continues async.
7. **T+10ms** — `resolveDestination(event, route)` runs `linear_attachment_thread`: calls `linear_graphql` for the parent issue's attachments, finds the first attachment whose `url` matches `https://<workspace>.slack.com/archives/<channel-id>/p<ts-no-dot>?thread_ts=<thread-ts>&cid=<channel-id>`, parses out `{channel, thread_ts}`. If no Slack attachment, falls back to `fallback_channel`.
8. **T+50ms** — `eventToMessage(event, route)` produces a `SlackTurnInput` with the comment author, the comment body excerpt, the issue identifier, and the resolved `{channel, thread_ts}`.
9. **T+60ms** — `pi-sdk-runner` consumes the synthetic turn. Pi has `linear_graphql` and `slack_api` available per the route's `tools:` list.
10. **T+1–4s** — Pi calls `slack_api` `conversations.replies` on `{channel, thread_ts}` to check whether a Pi-authored reply already covers this comment (idempotency). If yes, abort.
11. **T+2–5s** — Pi calls `slack_api` `chat.postMessage` into the thread with a structured summary and a permalink back to the Linear comment.
12. **T+5s** — Ledger entry appended to `sessions/event-runs.jsonl` with `status: "completed"`, `completedAt`, and the `sessionId` from the runner.

If anything between step 7 and 12 throws, the ledger entry carries `status: "failed"` and the failure surfaces to `#pi-event-runtime` (channel ID TBD — the integrator in Phase 3 fills this in).

## Idempotency contract

- **Key:** `<source>:<delivery-uuid>`. For Linear: the `Linear-Delivery` header.
- **Storage:** in-memory bounded cache. Max 10,000 entries; LRU eviction. TTL 24h. Sized for Linear's redelivery profile (up to 4 retries over ~7 hours).
- **Behavior on hit:** the receiver returns 200 immediately and does not dispatch. The agent is not woken; no ledger entry is written for the redelivery.
- **Second-layer idempotency:** even if the dedup cache misses (process restart, eviction), the agent's first action in the loop is `conversations.replies` against the destination thread, looking for a prior Pi-authored reply that already covers this Linear comment. The cache is the cheap defense; the thread scan is the durable one.
- **Persistence:** the in-memory cache disappears on process restart. Persistent dedup (disk or DB) is out of scope for v1 and tracked as a follow-up to issue #48.

## Safety model

- **Read-only event routes run autonomously.** The first production loop is *one* mutation (a Slack `chat.postMessage`), but if a future route only reads, it runs without approval.
- **Mutation event routes use draft+confirm.** The existing `permission-gate.ts` classifies every tool call; mutation calls from an event-fired route post an Approve/Cancel Block Kit message into the destination thread and pause until the human clicks.
- **Emergency kill switch:** `EVENT_RUNTIME_ENABLED=false`. Set it on Railway, redeploy, every delivery short-circuits to a logged no-op. No code change required to disable the entire runtime.
- **Per-source secrets are required.** A missing `LINEAR_WEBHOOK_SECRET` causes the receiver to reject every delivery for that source with 503 — we never accept unverified payloads.
- **Mutation boundary is unchanged.** Per `BOUNDARY.md`, MCP/tools remain bounded capabilities, not authority. The event runtime does not grant new permissions to any tool; it only changes who can wake a route.

## Observability

- **Ledger** — `sessions/event-runs.jsonl`. One line per delivery. `jq` it. Grep it by `deliveryId`, `source`, or `route`.
- **Slack failure channel** — `#pi-event-runtime` (channel ID TBD — the integrator in Phase 3 records the actual ID in `apps/pi-mom/.env.example`). Receiver-level failures (verification, resolution, agent error) land here.
- **Helper command** — `/pi-events status` reports the last 10 ledger entries. Available once Phase 3 wires the slash command into the existing Bolt adapter.
- **Pi session logs** — event-fired runs produce the same session shape as Slack-fired runs, so existing tooling (`apps/pi-mom/doctor.mjs`, Railway logs) continues to work.

## Testing locally

To exercise the Linear loop against a local pi-mom:

1. Start a tunnel: `ngrok http 3000` (or `cloudflared tunnel --url http://localhost:3000`). Note the public URL.
2. Set env in `apps/pi-mom/.env.local`:
   ```bash
   LINEAR_WEBHOOK_SECRET=<paste-from-Linear-webhook-settings>
   EVENT_RUNTIME_ENABLED=true
   ```
3. In Linear's workspace settings, create a webhook pointing at `https://<tunnel-host>/webhook/linear` with the same secret. Enable `Comment.create`.
4. Start pi-mom: `npm run dev:pi-mom`.
5. Open a test Linear issue that already has a Slack thread attachment (use the `linear:` route from Slack to create one if needed).
6. Post a comment on the issue.
7. Watch:
   - `tail -f sessions/event-runs.jsonl` for the ledger entry.
   - The linked Slack thread for the Pi reply (should appear within ~5s).

If nothing happens, see Troubleshooting in `docs/runbooks/add-event-source.md`.

## What's not built yet

Out of scope for issue #48 and tracked as separate follow-ups:

- **GitHub event sources** — `pull_request`, `issue_comment`, `check_run`, `workflow_run`. The architecture accommodates them; `docs/runbooks/add-event-source.md` uses GitHub PR webhooks as its worked example.
- **Cron / scheduled triggers** — daily standup digests, nightly hygiene passes.
- **Internal event chaining** — agent A finishes → fires agent B.
- **Persistent dedup** — move the in-memory cache to disk or DB. Required before the runtime can survive a redeploy mid-redelivery.
- **Real-time queue / broker** — BullMQ or similar, for high-throughput sources.
- **Multi-step approval flows** — approve → modify → approve again.
- **File-shared and reaction-added Slack events** as triggers.
- **Re-delivery UI inside Pi** — sources already have their own; we may surface a thin wrapper later.
