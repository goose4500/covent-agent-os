# Add a new event source

This runbook describes adding a new event source (GitHub, cron, internal event chaining, etc.) to the event-driven Pi runtime introduced in ADR-0003.

The runtime's whole point is that this is a config change, not a code change. The "code" needed for a new source is one ~5-line verifier and one switch case in the receiver. Everything else is YAML.

## When to use this runbook

- Adding a new webhook source (GitHub `pull_request`, GitHub `issue_comment`, cron, internal event chaining)
- Adding a new route that fires on an already-supported source's event type — only steps 4 and 6 apply
- Debugging an existing source that isn't firing — jump to Troubleshooting

If you only want Pi to react to a new Slack event (reaction, file_shared, etc.), this is *not* the right runbook — that goes through the Slack manifest and `apps/pi-mom/index.mjs`.

## Prerequisites

- Read ADR-0003 (`docs/adr/0003-event-driven-pi-runs.md`) and `docs/event-routing.md`.
- Access to the external service's webhook settings (to register a webhook + get its signing secret).
- A test environment where you can trigger the event safely (a sandbox repo, a test Linear issue, a scratch channel).
- Local pi-mom development setup working (`npm run dev:pi-mom`).

## Steps

### 1. Add the per-source signing secret to env

Add the secret name to `apps/pi-mom/.env.example` (placeholder only — never real values) and to the Railway production env. Naming convention: `<SOURCE>_WEBHOOK_SECRET`.

```bash
# apps/pi-mom/.env.example
GITHUB_WEBHOOK_SECRET=__set_in_secret_manager__
```

The receiver reads this at the moment of verification — there is no global registration step.

### 2. Add a verifier function in `apps/pi-mom/lib/event-signature.mjs`

Each verifier is a small pure function: `(rawBody, signatureHeader, secret) → boolean`. Use constant-time comparison.

```js
// apps/pi-mom/lib/event-signature.mjs
import crypto from "node:crypto";

export function verifyGithub(rawBody, signatureHeader, secret) {
  // GitHub sends "sha256=<hex>" in X-Hub-Signature-256
  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(signatureHeader || "", "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Keep verifiers boring. No JSON parsing, no logging of the body, no fallback secrets.

### 3. Wire the verifier into `apps/pi-mom/event-receiver.mjs`

The receiver dispatches by the `:source` URL param. Add a switch case:

```js
// inside the per-source verify step of POST /webhook/:source
switch (source) {
  case "linear":
    if (!verifyLinear(rawBody, req.headers["linear-signature"], process.env.LINEAR_WEBHOOK_SECRET)) return res.status(401).end();
    break;
  case "github":
    if (!verifyGithub(rawBody, req.headers["x-hub-signature-256"], process.env.GITHUB_WEBHOOK_SECRET)) return res.status(401).end();
    break;
  default:
    return res.status(404).end();
}
```

This is the only file you touch in `apps/pi-mom/` for a new source.

### 4. Define the route(s) in `apps/pi-mom/control-plane/registry.yaml`

Add one route per event type you want to react to. Use the `trigger:` block:

```yaml
- name: github-pr-review
  trigger:
    source: github
    when: ["pull_request.opened", "pull_request.synchronize"]
    idempotency: webhookDelivery
  destination:
    resolver: static_mapping
    mapping:
      "goose4500/covent-agent-os": C0XXXXXXX
    fallback_channel: C0YYYYYYY
  tools: [github_api, slack_api]
  systemPromptSuffix: |
    You woke up because GitHub emitted a pull_request event.
    The event payload is in the user turn. Decide whether and how to
    surface review context to the mapped Slack channel.
```

Route validation rejects unknown `source` values, so the schema gives you an immediate signal if the source name is wrong.

### 5. Add a destination resolver strategy (if needed)

Linear's `linear_attachment_thread` strategy works for any source that posts to threads attached to Linear issues. New sources usually need either `static_mapping` (already exists) or a new strategy in `apps/pi-mom/lib/destination-resolver.mjs`.

Add a new strategy only when the source has a meaningful "where should this land" signal embedded in its payload (e.g., a GitHub `pull_request` event carries `repository.full_name` → `org/repo` → channel via `static_mapping`; a Sentry alert might carry a project slug; etc.). Keep strategies pure: they take `(event, route)` and return `{channel, thread_ts?}`.

### 6. Test with a synthetic webhook payload

Before pointing real webhooks at the runtime, post a synthetic payload locally:

```bash
# capture a real payload from the source's "test delivery" or "ping" feature first,
# then replay it locally:
RAW_BODY="$(cat fixtures/github-pull-request-opened.json)"
SECRET="$GITHUB_WEBHOOK_SECRET"
SIG="sha256=$(printf '%s' "$RAW_BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"

curl -X POST http://localhost:3000/webhook/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: $(uuidgen)" \
  -H "X-Hub-Signature-256: $SIG" \
  --data-binary "$RAW_BODY"
```

Verify:

- Receiver returned 200 (not 401 or 404).
- A line appeared in `sessions/event-runs.jsonl`.
- The expected Slack message landed in the mapped channel.

Then enable the real webhook in the source's settings, pointing at the production pi-mom URL.

## Worked example — GitHub `pull_request` webhooks

Not shipping yet, but this is the canonical second source. Full wiring:

**Env:**

```bash
GITHUB_WEBHOOK_SECRET=__set_in_secret_manager__
```

**Verifier** (in `apps/pi-mom/lib/event-signature.mjs`):

GitHub uses `X-Hub-Signature-256: sha256=<hex>` over the raw body, secret = `GITHUB_WEBHOOK_SECRET`. See step 2 above for the full function.

**Receiver switch case** (in `apps/pi-mom/event-receiver.mjs`):

```js
case "github":
  if (!verifyGithub(rawBody, req.headers["x-hub-signature-256"], process.env.GITHUB_WEBHOOK_SECRET)) return res.status(401).end();
  break;
```

**Route YAML** (in `apps/pi-mom/control-plane/registry.yaml`):

```yaml
- name: github-pr-review
  trigger:
    source: github
    when: ["pull_request.opened", "pull_request.synchronize"]
    idempotency: webhookDelivery
  destination:
    resolver: static_mapping
    mapping:
      "goose4500/covent-agent-os": C0XXXXXXX
    fallback_channel: C0YYYYYYY
  tools: [github_api, slack_api]
```

**Destination resolver** — `static_mapping` already exists; key the mapping on `event.repository.full_name`. No new strategy needed.

**Response timeout** — GitHub gives 10 seconds. The receiver's "200 fast, process async" pattern already satisfies this.

**Idempotency key** — `github:<X-GitHub-Delivery>`. GitHub retries up to 7 times over ~3 days; the 24h dedup TTL covers most of that window, and the agent's thread-scan covers the rest.

## Troubleshooting

### 401 on every delivery — verification fails

- Confirm the env var is set in the running process: `printenv | grep WEBHOOK_SECRET`. A missing secret returns 503; a wrong secret returns 401.
- Confirm the header name in your switch case matches the source exactly. GitHub: `x-hub-signature-256` (Express lowercases). Linear: `linear-signature`.
- Confirm the receiver is verifying against the **raw** body, not a parsed JSON re-stringification. Use Express's `bodyParser.raw({type: "*/*"})` for the webhook route, not `bodyParser.json()`.
- Some sources prefix the hex with `sha256=` (GitHub) and some do not (Linear). Read your verifier carefully.

### 200, but no agent run

- Check `sessions/event-runs.jsonl`. If there's no entry, the route did not match — check `trigger.source` and `trigger.when` against the payload's event type. Linear uses `Comment.create`, GitHub uses `pull_request.opened`, etc.
- If the ledger says `status: "failed"`, the failure detail is in the same JSONL line and (for receiver-level failures) in the `#pi-event-runtime` Slack channel.
- Confirm `EVENT_RUNTIME_ENABLED` is not set to `false`.

### Duplicate Slack posts on the same event

- Check the dedup key format. The key is `<source>:<delivery-uuid>` — if the source sends a per-attempt UUID instead of a per-event UUID, the cache will not catch retries.
- Confirm the agent's idempotency check (thread-scan via `conversations.replies`) is running. The cache is the cheap defense; the thread-scan is the durable one.
- After a process restart the in-memory cache is empty, so a redelivered webhook will pass the cache and rely entirely on the thread-scan. Persistent dedup is a follow-up to issue #48.

### Source's "test delivery" works, real events don't

- Real events often carry an `event` type the test delivery does not (e.g. GitHub's "ping" event is type `ping`, not `pull_request`). Make sure the route's `trigger.when` matches the real event type.
- Verify the production URL is reachable from the source's egress range. Some sources publish IP allowlists.
