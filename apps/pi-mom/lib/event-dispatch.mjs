// Event-runtime dispatch (issue #48, phase 3).
//
// Glue between the webhook receiver and the existing pi-sdk-runner. The
// receiver hands us a verified, deduped event payload; we:
//
//   1. Match the event against the route registry.
//   2. Resolve a Slack destination via the destination resolver.
//   3. Build the synthetic turn input.
//   4. Invoke runPi with the route's tool allowlist + system-prompt suffix.
//   5. Append ledger entries at each milestone so a grep on deliveryId
//      reconstructs what happened.
//
// The agent itself performs the Slack post via the `slack_api` tool — we do
// NOT call client.chat.postMessage directly from the dispatch path. This keeps
// the dispatcher honest (it doesn't know Slack) and lets the agent decide
// whether to abort (e.g. duplicate Pi reply already in the thread; see the
// route's systemPromptSuffix in registry.yaml).
//
// Errors:
//   - Route-match miss → ledger "completed" with reason="no-route-matched". This
//     is not an error; it just means the route registry doesn't currently want
//     us to react. Keep the ledger entry as a debugging signal so operators
//     can confirm a delivery actually arrived.
//   - Destination-resolve miss → ledger "error". Without a destination the
//     agent has nowhere to post; the route should either succeed or be flagged.
//   - runPi throw → ledger "error" with redacted error message; the receiver
//     also writes its own "error" entry but we want one closer to the failure.
//
// Idempotency note: the receiver dedups by `<source>:<delivery-id>`. The
// route's systemPromptSuffix instructs the agent to scan the thread for a
// prior Pi reply and abort if found — see ADR-0003. We rely on that behavioral
// guard rather than persisting "seen deliveries" beyond the in-memory dedup.

import { getEventRoutes } from "./control-plane/registry-loader.mjs";
import { matchEventRoute } from "./event-route-matcher.mjs";
import { eventToTurnInput } from "./synthetic-message.mjs";

// Same redaction scope as redactSensitiveText in index.mjs — only the patterns
// most likely to slip into an error message. Full ANSI/terminal scrubbing
// lives downstream; here we just keep ledger entries safe to `tail -f`.
function redactErrorMessage(message) {
  return String(message || "")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "xox[REDACTED]")
    .replace(/xapp-[A-Za-z0-9-]+/g, "xapp-[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    .replace(/lin_api_[A-Za-z0-9_-]+/g, "lin_api_[REDACTED]")
    .replace(/Authorization:\s*[^\s'"`]+/gi, "Authorization: [REDACTED]");
}

/**
 * Build the prompt the agent sees. The route's systemPromptSuffix is prepended
 * as a leading instruction block, then the synthetic event turn follows. This
 * mirrors how the Slack handleRequest path composes its prompt (route
 * instruction first, then user request), so a route's systemPromptSuffix
 * behaves consistently whether triggered from Slack or from a webhook event.
 *
 * @param {object} route
 * @param {string} eventTurnText
 * @returns {string}
 */
function composePrompt(route, eventTurnText) {
  const suffix =
    typeof route?.systemPromptSuffix === "string" && route.systemPromptSuffix.trim().length > 0
      ? route.systemPromptSuffix.trim()
      : "";
  if (!suffix) return eventTurnText;
  return `${suffix}\n\n${eventTurnText}`;
}

/**
 * Factory that returns a `dispatch` function suitable for plugging into
 * `createEventReceiver({ dispatch })`. Everything is injected for testability:
 *
 *   - registry: parsed registry.yaml (the same shape `loadRegistry()` returns)
 *   - destinationResolver: `{resolve(event, route) -> {channel, thread_ts?} | null}`
 *   - runPi: (prompt, opts) -> Promise<string>
 *   - appendLedger: (entry) -> void (the same callback handed to the receiver)
 *   - logger: console-shaped
 *   - now: clock factory for ledger ts (defaults to Date.now)
 *
 * The returned function matches the receiver's dispatch contract:
 *   async ({ source, event, deliveryId, rawBody, headers }) -> void
 *
 * @param {object} deps
 * @returns {{dispatch: Function, _composePrompt: Function}}
 */
export function createEventDispatch({
  registry,
  destinationResolver,
  runPi,
  appendLedger = () => {},
  logger = console,
  now = Date.now,
} = {}) {
  if (!registry) throw new Error("createEventDispatch requires { registry }");
  if (!destinationResolver || typeof destinationResolver.resolve !== "function") {
    throw new Error("createEventDispatch requires { destinationResolver.resolve }");
  }
  if (typeof runPi !== "function") {
    throw new Error("createEventDispatch requires { runPi } function");
  }

  const eventRoutes = getEventRoutes(registry);

  async function dispatch({ source, event, deliveryId, rawBody, headers } = {}) {
    // 1. Route match -------------------------------------------------------
    const route = matchEventRoute(eventRoutes, source, event);
    if (!route) {
      appendLedger({
        ts: new Date(now()).toISOString(),
        deliveryId,
        source,
        status: "completed",
        reason: "no-route-matched",
      });
      logger?.info?.(`[event-dispatch] no route matched for ${source}/${event?.type}.${event?.action}`);
      return;
    }

    appendLedger({
      ts: new Date(now()).toISOString(),
      deliveryId,
      source,
      status: "route-matched",
      route: route.name,
    });

    // 2. Destination resolve ----------------------------------------------
    let destination = null;
    try {
      destination = await destinationResolver.resolve(event, route);
    } catch (err) {
      // Resolver implementations are written to never throw, but belt-and-braces.
      const message = redactErrorMessage(err?.message || String(err));
      appendLedger({
        ts: new Date(now()).toISOString(),
        deliveryId,
        source,
        status: "error",
        route: route.name,
        error: `destination resolver threw: ${message}`,
      });
      throw err;
    }

    if (!destination || typeof destination.channel !== "string") {
      appendLedger({
        ts: new Date(now()).toISOString(),
        deliveryId,
        source,
        status: "error",
        route: route.name,
        error: "no destination resolved",
      });
      return;
    }

    appendLedger({
      ts: new Date(now()).toISOString(),
      deliveryId,
      source,
      status: "destination-resolved",
      route: route.name,
      destination,
    });

    // 3. Build synthetic turn input ---------------------------------------
    const turn = eventToTurnInput({
      event,
      route,
      destination,
      deliveryId,
    });

    // 4. Invoke the agent --------------------------------------------------
    const prompt = composePrompt(route, turn.prompt);
    const tools = Array.isArray(route.tools) ? [...route.tools] : [];

    appendLedger({
      ts: new Date(now()).toISOString(),
      deliveryId,
      source,
      status: "agent-started",
      route: route.name,
      destination,
      tools,
    });

    try {
      // Pass `tools` so pi-sdk-runner narrows the active tool surface via
      // setActiveToolsByName. We don't pass a `sink` because there's no Slack
      // surface streaming — the agent posts its reply via the slack_api tool.
      // No uiContext: event runs are non-interactive; if a route ever needs
      // approval gating, a future iteration can plug a webhook-driven UI in.
      await runPi(prompt, { tools });
    } catch (err) {
      const message = redactErrorMessage(err?.message || String(err));
      appendLedger({
        ts: new Date(now()).toISOString(),
        deliveryId,
        source,
        status: "error",
        route: route.name,
        error: `agent run failed: ${message}`,
      });
      throw err;
    }

    appendLedger({
      ts: new Date(now()).toISOString(),
      deliveryId,
      source,
      status: "agent-completed",
      route: route.name,
    });
  }

  return {
    dispatch,
    // Exposed for tests + future debug endpoints. Treat as read-only.
    _composePrompt: composePrompt,
    _eventRoutes: eventRoutes,
  };
}
