# ADR 0006: Linear webhook receiver is colocated with `apps/pi-mom`

Date: 2026-05-10
Status: accepted
Related: PRD `docs/source-of-truth/LINEAR_INTEGRATION_PRD.md` (principles 9 and 10), ADR 0005, spec `docs/specs/linear-client-spec.md`, runbook `docs/runbooks/linear-webhook-setup.md`

## Context

We need a Linear webhook receiver to react to issue / comment / project / cycle events from the workspace. The receiver must verify Linear's HMAC-SHA256 signature on the raw request body, enforce a 60s replay window, dispatch by `type+action`, and respond with a 2xx fast (Linear retries on non-2xx).

`apps/pi-mom` is the existing Slack bridge — a long-running Node process running `@slack/bolt` in Socket Mode against a Railway service named `covent-pi-mom`. Bolt's Socket Mode does not bind an HTTP port; the worker keeps a WebSocket open to Slack. Today the process has no public HTTP surface at all.

Two reasonable shapes for the receiver were considered:

1. **Separate service.** Stand up a new Railway service whose only job is `/webhooks/linear`. Independent deploy, independent secrets, independent logs.
2. **Colocated in `apps/pi-mom`.** Add an HTTP listener inside the same Node process, on its own port, sharing env vars and the existing trace pipeline.

## Decision

Run the webhook receiver inside `apps/pi-mom`, on a separate HTTP port (`LINEAR_WEBHOOK_PORT`, default `3001`), exposing `/webhooks/linear`. Bolt's Socket Mode for Slack is untouched. The receiver verifies the signature via `@covent/linear-client`'s `webhooks.verify`, traces via pi-mom's existing `trace()`, and dispatches by `type+action`. PRD principle 10 binds this choice.

## Consequences

Positive:

- **Single Railway service.** The repo's deploy model stays simple: one service, one environment, one logs stream, one rollback. Adding a second service would multiply our ops surface for the same five-person team.
- **Shared secrets.** `LINEAR_API_KEY`, `LINEAR_WEBHOOK_SIGNING_SECRET`, and `LINEAR_WEBHOOK_SIGNING_SECRET_PREVIOUS` live in one Railway Variables set. No cross-service secret duplication.
- **Shared logs and trace pipeline.** Webhook events and Slack-originated events appear in the same `trace()` stream, which makes correlation (e.g. "Slack thread → Linear issue → Linear webhook back to update Slack") observable in one place.
- **Shared client instance.** The same `@covent/linear-client` facade that pi-mom uses outbound is reused for any webhook-driven re-entry into Linear, including the per-team `WorkflowStateCache`.

Negative / accepted tradeoffs:

- **Failure isolation is shared.** A panic in the webhook handler that brings down the Node process also brings down the Slack bridge. We mitigate at the receiver level: the handler runs in a try/catch, returns 4xx/5xx without rethrowing, and the verifier itself never sees a parsed body (so a malformed-but-signed payload still maps to `WebhookVerificationError`, not an uncaught throw). PRD principle 9 forces verification before parse.
- **HTTP shape inside a Socket Mode worker.** Pi-mom is Socket Mode today; adding an HTTP listener changes the runtime shape. We isolate by binding a **separate port** (not Bolt's) and starting the listener independently of Bolt's lifecycle. Health checks remain decoupled.
- **A receiver bug could block Slack traffic.** If the webhook listener's port binding fails on startup, the operator must decide whether to keep the Slack bridge up without webhooks or roll back. The runbook covers the rollback path.
- **Scaling is coupled.** If webhook volume ever forces horizontal scaling, we have to scale Slack-Socket replicas at the same time (the PRD already flags the concurrent-replica race on `upsertFromSlack` as a v2 problem). The trade is acceptable for the current load.

The colocation choice is reversible: extracting the receiver into a separate service later is straightforward because the verifier and dispatcher already live in `@covent/linear-client`. The trigger for revisiting would be either webhook volume that destabilizes the Slack bridge, or a need to scale them on independent cadences.

## References

- PRD: `docs/source-of-truth/LINEAR_INTEGRATION_PRD.md` (principles 9 and 10, risks section on Socket Mode + HTTP cohabitation).
- ADR 0005: `@covent/linear-client` consolidation — the verifier this ADR consumes.
- Spec: `docs/specs/linear-client-spec.md` — `verifyWebhook` contract.
- Runbook: `docs/runbooks/linear-webhook-setup.md` — workspace configuration, rotation, IP allow-list.
