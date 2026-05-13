# ADR 0003: Event-driven Pi runs via synthetic Slack messages

Date: 2026-05-13
Status: accepted
Related: issue #48, ADR-0001, ADR-0002, `apps/pi-mom/event-receiver.mjs`, `apps/pi-mom/control-plane/registry.yaml`

## Context

Today every Pi agent run starts from a Slack message — a DM or an `@Covent-Agent` mention. External systems cannot trigger Pi. This is the bottleneck behind three concrete problems:

1. **Linear ↔ Slack two-way is broken.** Pi can create Linear issues from Slack threads (ADR-0002), but Linear comments and status updates stay in Linear. Conversations fork.
2. **GitHub PR review automation has no entry point.** "PR opened," "checks failed," "review requested" — none of these can wake an agent.
3. **No scheduled or chained runs.** A daily standup digest, a nightly Linear hygiene pass, or "after agent A finishes, fire agent B" have nowhere to live.

The default solution — write a bespoke integration per source — scatters glue code across the repo, multiplies the observability surface, and forces every new source to reinvent signature verification, dedup, and approval gating.

## Decision

**Every event becomes a synthetic Slack message.** A webhook receiver verifies, dedups, resolves a destination (channel + thread), packages the event as a turn input, and hands it to the existing `pi-sdk-runner` that already handles real Slack messages. The route registry decides what to do.

There is one execution path. Many trigger sources. The route registry (`apps/pi-mom/control-plane/registry.yaml`) remains the single source of truth for what Pi will do with an incoming turn — whether that turn came from a human in Slack, a Linear webhook, a future GitHub webhook, or a cron tick.

Routes opt into event triggering via a new optional `trigger:` block:

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

Routes without a `trigger:` block continue to behave exactly as today: Slack-message-only.

## Rationale

- **Adding an event source becomes a config change, not a code change.** The receiver, destination resolver, ledger, and approval gate are written once and never touched per-source. A new source means: one env var (the signing secret), one ~5-line verifier, one route YAML block.
- **Matches the Pi philosophy.** Per `BOUNDARY.md` and the repo's MCP/tools-as-bounded-capabilities stance: keep the runtime minimal, push behavior into config and skills. The event runtime is six small primitives, not a new framework.
- **Reuses existing safety surfaces.** Mutation routes inherit `permission-gate.ts` and the Slack approval modal automatically — there is no parallel approval pipeline to keep in sync.
- **Reuses existing observability surfaces.** A run triggered by a Linear webhook is the same shape as a run triggered by `@Covent Pi` — same logs, same session records, plus one extra JSONL ledger entry that says "this run was webhook-fired."
- **Single deployment target.** The receiver mounts on the existing Bolt/Express adapter inside `apps/pi-mom`. No new service, no new container, no second pager rotation.

## Alternatives considered

1. **Per-source bespoke integrations.** Write a Linear handler that pokes Slack directly, a GitHub handler that pokes Linear, etc. *Rejected:* scatters glue code, duplicates verification + dedup + approval logic per source, multiplies the surface area future engineers must learn.
2. **Standalone "event runtime" service.** A separate process that consumes webhooks and pushes work into Pi over an internal API. *Rejected:* parallel pipeline, parallel observability stack, parallel deployment story, parallel auth boundary — all for capability we get for free by mounting on the existing Bolt app.
3. **Wait for MCP eventing to mature and let MCP push events into Pi.** *Rejected:* per ADR-0001 and the repo's MCP stance, MCP/tools are bounded capabilities, not authority. We do not lean on MCP for control flow. Events arriving as webhooks under our verification keeps the trust boundary inside this repo.

## Consequences

### Positive

- One mental model for every Pi run: an event becomes a turn, a turn hits the registry, the registry decides.
- The cost of a new event source drops to a config-level change.
- Existing approval, ledger, and route-policy infrastructure all "just work" for event-fired runs.
- Failures land in the same Slack cockpit as Slack-fired runs (with a dedicated channel for receiver-level failures — see `docs/event-routing.md`).

### Negative

- Synthetic messages need to be readable enough that the model handles them well. The synthetic message builder (`apps/pi-mom/lib/synthetic-message.mjs`) is therefore a load-bearing piece of prompt engineering, not just plumbing.
- We are on the hook for HMAC signature verification correctness per source. A bug here means either dropped events (missed work) or accepted forgeries (impersonated work). Per-source verifiers live in `apps/pi-mom/lib/event-signature.mjs` and must be unit-tested with valid, invalid, and replay cases.
- **Idempotency is critical.** A webhook gone wrong is a duplicate Slack post in a real channel. The dedup cache (24h TTL, 10k entry cap, sized for Linear's 4-retry-over-7-hours redelivery pattern) is the first line of defense; the agent's own idempotency check (scan the thread first) is the second.
- A misconfigured route with a mutation tool can fire on every webhook delivery. The default for event-fired mutations is draft+confirm via `permission-gate.ts`; read-only event routes run autonomously. `EVENT_RUNTIME_ENABLED=false` is the emergency kill switch.

## First production loop

To prove the architecture, issue #48 ships exactly one loop end-to-end:

**Linear `Comment.create` → Slack thread reply.**

```text
Linear posts Comment.create webhook
  → POST /webhook/linear
  → verify Linear-Signature (hex HMAC-SHA256, secret LINEAR_WEBHOOK_SECRET)
  → check webhookTimestamp within 60s, dedup on <linear>:<Linear-Delivery>
  → 200 OK to Linear (within Linear's 5s budget)
  → resolveDestination(event, route) → {channel, thread_ts}
       via linear_attachment_thread strategy:
       fetch issue attachments, find Slack permalink, parse → channel + ts
  → eventToMessage(event, route) → SlackTurnInput
  → pi-sdk-runner consumes the turn (unchanged)
  → Pi reads context via linear_graphql, calls slack_api chat.postMessage
       into the resolved thread, summarizing the comment with a permalink
       back to Linear
  → ledger entry written to sessions/event-runs.jsonl
```

Idempotent end-to-end: the agent scans the thread before posting, so a redelivered webhook produces zero additional Slack messages.

This loop is chosen because it exercises both newly-shipped tools (`linear_graphql`, `slack_api`), forces the destination resolver to do real work (attachment lookback), has a bounded mutation surface (one `chat.postMessage`), and is high-signal enough to verify by eye (post a comment, see the reply within 5s).

## Open questions

1. **Cache lifetime defaults.** 24h TTL + 10k entries is sized for Linear's redelivery profile. GitHub and future sources may need different values. Resolved per-source as we add them; the in-memory cache abstraction in `apps/pi-mom/lib/event-dedup.mjs` should make this trivial.
2. **Kill-switch UX.** `EVENT_RUNTIME_ENABLED=false` is sufficient for v1. A `/pi-events pause` slash command — and a Slack-visible status banner — are deferred to a follow-up.
3. **Should the agent's Slack reply also post back to Linear as a comment ("relayed to Slack")?** Nice-to-have, not MVP. Deferred. If we add it, the relay-comment should itself carry an idempotency key so a redelivered webhook does not create a duplicate Linear comment.

## Out of scope (filed separately)

- GitHub webhook sources (`pull_request`, `issue_comment`, `check_run`, `workflow_run`)
- Cron / scheduled triggers
- Internal event chaining (agent A finishes → fires agent B)
- Persistent dedup store (move from in-memory to disk or DB)
- Real-time queue / broker (BullMQ) for high-throughput sources
- Multi-step approval flows
- File-shared and reaction-added Slack events as triggers
