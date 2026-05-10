# Linear Webhook Setup

Status: runbook for configuring and operating Linear webhooks for pi-mom
Last updated: 2026-05-10
PRD: [`docs/source-of-truth/LINEAR_INTEGRATION_PRD.md`](../source-of-truth/LINEAR_INTEGRATION_PRD.md) (principles 9 and 10)
Spec: [`docs/specs/linear-client-spec.md`](../specs/linear-client-spec.md)
ADR: [`docs/adr/0006-linear-webhooks-colocated-with-pi-mom.md`](../adr/0006-linear-webhooks-colocated-with-pi-mom.md)

This runbook describes the **future state** of the Linear webhook integration. The verifier (`packages/linear-client/src/webhooks.ts`) ships now; the HTTP receiver at `/webhooks/linear` is owned by W-B and will land in `apps/pi-mom` shortly. Steps that depend on the receiver are explicitly called out.

## Pre-requisites

- Linear workspace admin access. Only workspace admins can create webhooks.
- A pi-mom deployment that exposes the `LINEAR_WEBHOOK_PORT` on a public hostname reachable from Linear. The default port is `3001`.
- The following secret slots populated in the deployment's environment (values stay in 1Password / Railway Variables, never in this repo):
  - `LINEAR_WEBHOOK_SIGNING_SECRET` — required.
  - `LINEAR_WEBHOOK_SIGNING_SECRET_PREVIOUS` — only during a rotation window.
  - `LINEAR_WEBHOOK_PORT` — optional, default `3001`.

`LINEAR_API_KEY` is a separate concern (used for outbound Linear calls). The signing secret is webhook-only.

## Create the webhook in Linear

1. Open `https://linear.app/<workspace>/settings/api/webhooks` and click **New webhook**.
2. **URL** — point at the pi-mom deployment's webhook listener: `https://<pi-mom-host>:<LINEAR_WEBHOOK_PORT>/webhooks/linear`. With the default port that is `https://<pi-mom-host>:3001/webhooks/linear`. Use whatever public hostname terminates TLS for that port.
3. **Signing secret** — Linear generates one. Copy it once into 1Password under `LINEAR_WEBHOOK_SIGNING_SECRET`. Do not paste it anywhere else.
4. **Resource types** — subscribe to:
   - `Issue`
   - `Comment`
   - `Project`
   - `ProjectUpdate`
   - `Reaction`
   - `IssueAttachment`
   - `Cycle`

   Adjust later as new pi-mom routes need them; do not over-subscribe.
5. Save the webhook. Linear sends a test event immediately.

## Verify with `curl` (without the receiver)

While the W-B receiver is in flight, you can dry-run the verifier locally using the fixture data in `packages/linear-client/tests/fixtures/webhook.ts`:

```bash
# From the repo root, with a Node shell that has @covent/linear-client linked.
node -e '
  import { verifyWebhook } from "@covent/linear-client";
  import {
    FIXTURE_BODY,
    FIXTURE_SECRET,
    FIXTURE_SIGNATURE,
    FIXTURE_TIMESTAMP_MS,
  } from "./packages/linear-client/tests/fixtures/webhook.ts";

  const event = verifyWebhook({
    rawBody: FIXTURE_BODY,
    headers: { "linear-signature": FIXTURE_SIGNATURE },
    secret: FIXTURE_SECRET,
    now: () => FIXTURE_TIMESTAMP_MS,
  });
  console.log(event.type, event.action);
'
```

The same HMAC can be reproduced with OpenSSL for parity:

```bash
printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex
```

Once the receiver is live, send a real `curl` request to `/webhooks/linear` and confirm the trace stream emits `linear.webhook.verify.succeeded`. Tampered bodies or stale timestamps must trace `linear.webhook.verify.invalid_signature` / `replay_expired` respectively.

## Signing-secret rotation

Linear has no `Linear-Signature-Previous` header (Wave 2 R3 confirmed). Zero-downtime rotation is implemented at the verifier boundary by trying multiple secrets in turn. The procedure:

1. In the Linear UI, click **Regenerate signing secret** on the webhook. Linear shows the new secret once.
2. Set `LINEAR_WEBHOOK_SIGNING_SECRET_PREVIOUS` to the **old** secret. Set `LINEAR_WEBHOOK_SIGNING_SECRET` to the **new** secret. (Both in 1Password / Railway Variables. Never in this repo or in Slack.)
3. Deploy. The verifier in `packages/linear-client/src/webhooks.ts` accepts both: it computes HMACs with `secret` first, then each entry of `additionalSecrets` (which the receiver populates from `LINEAR_WEBHOOK_SIGNING_SECRET_PREVIOUS`). Comparison is constant-time via `crypto.timingSafeEqual`.
4. In Linear, click **Send test event**. Confirm the deployment trace shows `linear.webhook.verify.succeeded` with the new secret in effect.
5. On the next deploy after the rotation window, remove `LINEAR_WEBHOOK_SIGNING_SECRET_PREVIOUS` from the environment. The window length is operator's discretion — Linear's "Send test event" returns within seconds, so a same-day removal is fine for the POC.

Use placeholders like `whsec_test_…` in any sample config; the real values stay in the secret store.

## Failure modes and trace mapping

`verifyWebhook` throws `WebhookVerificationError` with a typed `code`. The W-B receiver maps each code to an HTTP status and emits the corresponding trace event:

| Trace event | `WebhookVerificationError.code` | HTTP status |
|---|---|---|
| `linear.webhook.verify.missing_signature` | `missing_signature` | 401 |
| `linear.webhook.verify.invalid_signature` | `invalid_signature` | 401 |
| `linear.webhook.verify.replay_expired` | `replay_expired` | 400 |
| `linear.webhook.verify.malformed_payload` | `malformed_payload` | 400 |
| `linear.webhook.verify.succeeded` | (success) | 200 |

`malformed_payload` covers three sub-cases inside the verifier: the body is not a JSON object; `webhookTimestamp` is missing or not a finite number; `action` / `type` are missing or not strings. The trace event name is the same for all three — inspect the thrown error message to disambiguate during triage.

If the receiver itself crashes before reaching the verifier (for example, because `bodyParser.raw` was not wired and `express.json` ate the stream), Linear sees a 500 / timeout and retries with exponential backoff. The fix is on the receiver side; the verifier never sees a parsed body.

## Source IPs to allowlist (optional)

If the deployment's networking layer requires explicit allow-listing, Linear sends webhooks from:

```
35.231.147.226
35.243.134.228
34.140.253.14
34.38.87.206
34.134.222.122
35.222.25.142
```

These IPs are documented by Linear and may change. Re-check Linear's API docs before relying on the list. The HMAC verification is the security boundary; IP allow-listing is defense-in-depth.

## Cross-references

- PRD: [`docs/source-of-truth/LINEAR_INTEGRATION_PRD.md`](../source-of-truth/LINEAR_INTEGRATION_PRD.md) — principles 9 (webhook integrity) and 10 (colocated receiver).
- Spec: [`docs/specs/linear-client-spec.md`](../specs/linear-client-spec.md) — `verifyWebhook` signature and error taxonomy.
- ADR 0006: [`docs/adr/0006-linear-webhooks-colocated-with-pi-mom.md`](../adr/0006-linear-webhooks-colocated-with-pi-mom.md) — why the receiver runs inside `apps/pi-mom`.
- Receiver (future): `apps/pi-mom/index.mjs` after W-B lands. This runbook is forward-looking until then.
