// Event-route matcher for the event-driven Pi runtime (issue #48, phase 3).
//
// Given the parsed webhook event + the list of event-triggered routes from the
// registry, find the first route whose `trigger` block matches the incoming
// event. Pure — no I/O, no module-scope state. Same inputs always produce the
// same output.
//
// Match contract:
//   - `route.trigger.source` must equal `source` (e.g. "linear", "github").
//   - `route.trigger.when` must include the event-type token. Token shape is
//     `${event.type}.${event.action}` for Linear (e.g. "Comment.create",
//     "Issue.update"); GitHub webhooks will use a different shape (issue #48
//     phase 4+) and the matcher will need a per-source token builder. For
//     v1 only Linear is wired.
//
// Returns the matched route object or `null`. Never throws — bad inputs
// collapse to "no match" so the dispatch layer falls through to a clean
// "no-route-matched" ledger entry rather than an exception.

/**
 * Build the event-type token used to match against `route.trigger.when`.
 *
 * For Linear webhooks the token is `<type>.<action>` (capitalized type,
 * lowercase action — Linear emits exactly that shape). For unknown sources
 * we still attempt the same shape; if a future source needs a different
 * token format, branch here on `source`.
 *
 * @param {string} source
 * @param {any} event
 * @returns {string | null}
 */
export function buildEventTypeToken(source, event) {
  if (!event || typeof event !== "object") return null;
  const type = typeof event.type === "string" && event.type ? event.type : "";
  const action = typeof event.action === "string" && event.action ? event.action : "";
  if (type && action) return `${type}.${action}`;
  if (type) return type;
  return null;
}

/**
 * Find the first event-triggered route whose `trigger` block matches the
 * (source, event) pair. The token is built via `buildEventTypeToken`.
 *
 * @param {Array<object>} eventRoutes - from `getEventRoutes(registry)`
 * @param {string} source - "linear" | "github" | ...
 * @param {any} event - parsed webhook body
 * @returns {object | null}
 */
export function matchEventRoute(eventRoutes, source, event) {
  if (!Array.isArray(eventRoutes) || eventRoutes.length === 0) return null;
  if (typeof source !== "string" || source.length === 0) return null;

  const token = buildEventTypeToken(source, event);
  if (!token) return null;

  for (const route of eventRoutes) {
    const trigger = route?.trigger;
    if (!trigger || typeof trigger !== "object") continue;
    if (trigger.source !== source) continue;
    if (!Array.isArray(trigger.when)) continue;
    if (trigger.when.includes(token)) return route;
  }
  return null;
}
