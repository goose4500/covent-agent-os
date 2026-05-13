// Synthetic message builder for the event-driven Pi runtime (issue #48, phase 2).
//
// Transforms a verified webhook event + the matched route + a resolved Slack
// destination into a "turn input" that the existing pi-sdk-runner can consume.
//
// The integrator (Phase 3) wires this between the receiver and the runner:
//
//   receiver → dispatch({source, event, deliveryId, ...})
//             → match event against route registry
//             → resolveDestination(event, route) → {channel, thread_ts?}
//             → eventToTurnInput({event, route, destination, deliveryId})
//             → runPi(turn.prompt, { ... }) + downstream Slack/Linear plumbing
//
// What this module does:
//   - Produces the user-turn TEXT the model will see ("prompt"). Format is a
//     compact XML/Markdown block — easy for the model to parse, easy for a
//     human to grep in logs.
//   - Returns the resolved destination verbatim for the caller to use when
//     posting the agent's reply.
//   - Surfaces routing metadata in a single `meta` object the caller can log,
//     ledger, or pass through to a session record.
//
// What this module does NOT do:
//   - Import the receiver, the pi-sdk-runner, or any Slack/Linear SDK.
//   - Throw. Webhook payloads are untrusted, sometimes weird, and the runtime
//     must still produce a usable turn input even when fields are missing.
//   - Decide whether the model SHOULD run. Route matching + kill-switch checks
//     belong upstream.
//
// Purity: same inputs produce same outputs. Time, randomness, and I/O are
// injected via `now`. No module-scope mutable state.

// Cap the embedded payload at ~4KB. Webhook bodies can be much larger (Linear
// Issue events occasionally exceed 30KB once attachments and labels balloon)
// and stuffing the whole thing into the user turn wastes context budget. The
// model has the tools to fetch the canonical record if it needs more detail.
const PAYLOAD_BUDGET_BYTES = 4096;

/**
 * Best-effort extraction of the event type string ("Comment.create",
 * "Issue.update", etc). Linear webhooks carry the event class on `event.type`
 * and the action on `event.action`. Other sources may differ; fall back
 * gracefully so the builder never throws.
 *
 * @param {any} event
 * @returns {string}
 */
function extractEventType(event) {
  if (!event || typeof event !== "object") return "unknown";
  const type = typeof event.type === "string" && event.type ? event.type : "";
  const action = typeof event.action === "string" && event.action ? event.action : "";
  if (type && action) return `${type}.${action}`;
  if (type) return type;
  if (action) return action;
  return "unknown";
}

/**
 * XML-attribute escape. We only emit attribute values we control plus a few
 * fields out of the webhook (channel id, thread_ts, deliveryId, event type),
 * but the deliveryId / channel could in theory be attacker-influenced, so be
 * paranoid: escape the five XML metacharacters and drop control bytes.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeAttr(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    // Drop ASCII control characters that would break the XML-ish parser even
    // when escaped; webhook UUIDs and Slack IDs never contain these.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * JSON-stringify the event payload, then truncate to PAYLOAD_BUDGET_BYTES.
 * When truncated, returns the truncated string PLUS the number of dropped
 * bytes so the caller can emit a `<truncated bytes="N"/>` marker.
 *
 * Indented (2-space) JSON is more model-friendly than compact JSON despite
 * the extra bytes — text-only models, especially older ones, parse pretty
 * JSON noticeably better.
 *
 * @param {any} payload
 * @returns {{text: string, truncatedBytes: number}}
 */
function stringifyPayload(payload) {
  let text;
  try {
    text = JSON.stringify(payload, null, 2);
  } catch {
    // Cyclic refs or other JSON.stringify failures — fall back to a coarse
    // marker rather than throwing. The model still sees the route + metadata
    // and can decide what to do.
    return { text: '"<unserializable payload>"', truncatedBytes: 0 };
  }
  if (typeof text !== "string") {
    // JSON.stringify returns undefined for `undefined`, functions, etc.
    return { text: '"<empty payload>"', truncatedBytes: 0 };
  }
  // Byte length matters more than char length for context budgeting; use
  // Buffer to count UTF-8 bytes accurately.
  const fullBytes = Buffer.byteLength(text, "utf8");
  if (fullBytes <= PAYLOAD_BUDGET_BYTES) {
    return { text, truncatedBytes: 0 };
  }
  // Walk back from the budget until we land on a valid UTF-8 boundary. Buffer
  // .slice + toString("utf8") will replace partial code units with U+FFFD,
  // which is acceptable for a debug-style payload preview.
  const buf = Buffer.from(text, "utf8").subarray(0, PAYLOAD_BUDGET_BYTES);
  const truncated = buf.toString("utf8");
  return { text: truncated, truncatedBytes: fullBytes - PAYLOAD_BUDGET_BYTES };
}

/**
 * Build the structured `<event>...</event>` block that opens the user turn.
 * Exported so tests can assert against this fragment directly without
 * re-implementing the format.
 *
 * @param {any} event
 * @param {{source: string, route?: any, destination?: any, deliveryId?: string, eventType?: string}} ctx
 * @returns {string}
 */
export function formatEventBlock(event, ctx = {}) {
  const source = ctx.source || "unknown";
  const eventType = ctx.eventType || extractEventType(event);
  const deliveryId = ctx.deliveryId;
  const routeName = ctx.route?.name;
  const destination = ctx.destination;

  const eventAttrs = [
    `source="${escapeAttr(source)}"`,
    `type="${escapeAttr(eventType)}"`,
  ];
  if (deliveryId) eventAttrs.push(`deliveryId="${escapeAttr(deliveryId)}"`);

  const lines = [`<event ${eventAttrs.join(" ")}>`];

  if (routeName) {
    lines.push(`<route name="${escapeAttr(routeName)}"/>`);
  }

  if (destination && typeof destination.channel === "string") {
    const destAttrs = [`channel="${escapeAttr(destination.channel)}"`];
    // Only emit thread_ts when present — the route's fallback strategy
    // intentionally omits it, and the absence is a signal to the model that
    // it's posting a top-level message.
    if (typeof destination.thread_ts === "string" && destination.thread_ts) {
      destAttrs.push(`thread_ts="${escapeAttr(destination.thread_ts)}"`);
    }
    lines.push(`<destination ${destAttrs.join(" ")}/>`);
  }

  const { text, truncatedBytes } = stringifyPayload(event);
  if (truncatedBytes > 0) {
    lines.push(`<truncated bytes="${truncatedBytes}"/>`);
  }
  lines.push("<payload>");
  lines.push(text);
  lines.push("</payload>");
  lines.push("</event>");

  return lines.join("\n");
}

/**
 * Build the full turn input from an event + route + destination.
 *
 * The returned `prompt` is what the model sees as the user turn. The
 * companion `destination` is pass-through metadata the caller uses to post
 * the eventual agent reply (the runner itself does not own Slack posting in
 * this codebase). `meta` carries the routing context that should land in the
 * event ledger entry and any session record.
 *
 * Never throws. Missing fields collapse to "unknown" / undefined; the model
 * still receives the raw payload and can decide what (if anything) to do.
 *
 * @param {object} params
 * @param {any} params.event - parsed webhook body
 * @param {{name?: string, trigger?: any, destination?: any, tools?: string[]}} [params.route]
 * @param {{channel: string, thread_ts?: string} | null} [params.destination]
 * @param {string} [params.deliveryId]
 * @param {() => string} [params.now] - injected for testability
 * @returns {{prompt: string, destination: any, meta: {source: string, deliveryId?: string, routeName?: string, eventType: string, triggeredAt: string}}}
 */
export function eventToTurnInput({
  event,
  route,
  destination,
  deliveryId,
  now = () => new Date().toISOString(),
} = {}) {
  const source =
    (route?.trigger?.source && typeof route.trigger.source === "string"
      ? route.trigger.source
      : undefined) || "unknown";
  const eventType = extractEventType(event);
  const block = formatEventBlock(event, {
    source,
    route,
    destination: destination || undefined,
    deliveryId,
    eventType,
  });

  // The instruction tail is intentionally short: the route's system-prompt
  // suffix carries the workflow-specific instructions, and we don't want this
  // synthetic turn to drown them out. We do two things only:
  //   1. Anchor the model on the fact that the trigger was an external event.
  //   2. Discourage hallucinated facts. Webhook payloads are partial views;
  //      the model has tools (linear_graphql, slack_api) to fetch more.
  const prompt =
    `${block}\n\n` +
    "You woke up because of the event above. Follow the route's instructions " +
    "(your system prompt suffix carries them). Do not invent details that " +
    "are not present in the payload — use the available tools (e.g. " +
    "`linear_graphql`, `slack_api`) to fetch anything else you need.";

  const meta = {
    source,
    eventType,
    triggeredAt: now(),
  };
  if (deliveryId) meta.deliveryId = deliveryId;
  if (route?.name) meta.routeName = route.name;

  return {
    prompt,
    destination: destination || null,
    meta,
  };
}
