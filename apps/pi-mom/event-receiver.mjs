// HTTP webhook receiver for the event-driven Pi runtime (issue #48, phase 1).
//
// This module is the front door. It does five things, and only these five:
//
//   1. Routes by `:source` URL parameter (e.g. /webhook/linear).
//   2. Verifies the source's HMAC signature against the RAW request body.
//   3. Verifies the body's `webhookTimestamp` is within a 60s replay window.
//   4. Deduplicates by the source's delivery ID header.
//   5. Responds 200 within the 5s budget Linear allows, then dispatches the
//      event asynchronously.
//
// What it does NOT do — by design, so the integrator can wire phase-2/3
// components without touching this file:
//   - It does not import the resolver, message builder, or pi-sdk-runner.
//     `dispatch` is injected. `appendLedger` is injected.
//   - It does not parse skill routes or build agent prompts.
//   - It does not understand Linear's data model. It just hands the event
//     object to `dispatch` and gets out of the way.
//
// Wiring contract (read this if you're the integrator):
//   - Mount with: `app.post("/webhook/:source", receiver.handle)`
//   - The express.json() middleware MUST capture the raw body, e.g.
//       app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }))
//     If `req.rawBody` is missing the handler responds 400 with a clear hint.
//   - `secrets` is `{ linear?: string, github?: string, ... }`. A source with
//     no secret returns 404 (treats unknown source as "not enabled").
//
// Env contract (informational; the integrator owns .env.example):
//   LINEAR_WEBHOOK_SECRET   required when Linear webhooks are enabled
//   GITHUB_WEBHOOK_SECRET   future, when GitHub webhooks are wired

import { createDedupCache } from "./lib/event-dedup.mjs";
import { verifyLinear, isFreshTimestamp } from "./lib/event-signature.mjs";

// Per-source plumbing lives in this table so adding a new source means
// adding a row, not editing the request handler. Phase-2 (GitHub) adds:
//   github: { signatureHeader: "x-hub-signature-256",
//             deliveryHeader: "x-github-delivery",
//             verify: verifyGithub }
const SOURCE_ADAPTERS = {
  linear: {
    signatureHeader: "linear-signature",
    deliveryHeader: "linear-delivery",
    verify: verifyLinear,
  },
  // EXTENSION POINT: add { github: {...} } here when wiring GitHub webhooks.
  // The handler below is source-agnostic once an adapter row exists.
};

function safeJsonParse(buf) {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

export function createEventReceiver({
  secrets = {},
  dispatch,
  appendLedger = () => {},
  dedup = createDedupCache(),
  now = Date.now,
  logger = console,
} = {}) {
  if (typeof dispatch !== "function") {
    throw new Error("createEventReceiver requires { dispatch } function");
  }

  async function handle(req, res) {
    const source = req?.params?.source;
    const adapter = source ? SOURCE_ADAPTERS[source] : undefined;
    const secret = source ? secrets[source] : undefined;

    // Unknown source OR known source with no secret configured → 404. We
    // collapse these because both mean "this surface isn't enabled" from the
    // sender's perspective, and we don't want to advertise which adapters
    // exist.
    if (!adapter || !secret) {
      res.status(404).json({ ok: false, error: "unknown source" });
      return;
    }

    const rawBody = req.rawBody;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      res.status(400).json({
        ok: false,
        error:
          "raw body required (set express.json({ verify: captureRawBody }))",
      });
      return;
    }

    const signature = req.headers?.[adapter.signatureHeader];
    if (!adapter.verify(rawBody, signature, secret)) {
      res.status(401).json({ ok: false, error: "invalid signature" });
      return;
    }

    const body = safeJsonParse(rawBody);
    if (!body || typeof body !== "object") {
      res.status(400).json({ ok: false, error: "invalid json" });
      return;
    }

    if (!isFreshTimestamp(body.webhookTimestamp, { now })) {
      res.status(401).json({ ok: false, error: "stale timestamp" });
      return;
    }

    const deliveryId = req.headers?.[adapter.deliveryHeader];
    const dedupKey = `${source}:${deliveryId || "no-delivery-id"}`;
    if (dedup.seen(dedupKey)) {
      res.status(200).json({ ok: true, dedup: true });
      return;
    }
    dedup.record(dedupKey);

    // Respond IMMEDIATELY — Linear's webhook timeout is 5s and we don't know
    // how long downstream agent work will take. The dispatch + ledger calls
    // run on the next tick.
    res.status(200).json({ ok: true, queued: true });

    const startedAt = now();
    appendLedger({
      deliveryId,
      source,
      event: body,
      status: "started",
      startedAt,
    });

    // Defer to next tick so the response is flushed before any heavy work
    // begins. setImmediate is preferable to queueMicrotask here because
    // microtasks run before I/O callbacks, and we want the socket write to
    // hit the network first.
    setImmediate(async () => {
      try {
        await dispatch({
          source,
          event: body,
          deliveryId,
          rawBody,
          headers: req.headers,
        });
        appendLedger({
          deliveryId,
          source,
          event: body,
          status: "completed",
          startedAt,
          completedAt: now(),
        });
      } catch (err) {
        // Best-effort log; the ledger entry is the durable signal. We
        // deliberately do NOT call res.* here — the response has already
        // been sent.
        try {
          logger?.error?.(
            `event-receiver dispatch error (${source}/${deliveryId}): ${err?.message || err}`,
          );
        } catch {}
        appendLedger({
          deliveryId,
          source,
          event: body,
          status: "error",
          error: err?.message || String(err),
          startedAt,
          completedAt: now(),
        });
      }
    });
  }

  return {
    handle,
    // Exposed for tests + future phases that want to inspect dedup state
    // (e.g. a /debug endpoint). Do NOT mutate from outside.
    _dedup: dedup,
  };
}
