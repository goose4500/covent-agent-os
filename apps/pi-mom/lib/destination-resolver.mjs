// Destination resolver for the event-driven Pi runtime.
//
// Given a parsed webhook event and the matched route config, return a Slack
// destination `{channel, thread_ts?}` (or `null` if nothing resolves). Three
// strategies are supported, selected via `route.destination.resolver`:
//
//   1. `linear_attachment_thread` — query Linear for the issue's attachments,
//      pick the first attachment that is a Slack permalink, parse it. Used to
//      route Linear webhook events (Comment/Issue) back into the originating
//      Slack thread.
//   2. `static_mapping` — look up a destination channel by a key the event
//      provides. Interface only for v1; stubbed to return `null`.
//   3. `fallback_channel` — always returns the configured fallback channel
//      (no thread_ts). Used both as a standalone strategy and as the final
//      safety net for the other two.
//
// Purity: this module is intentionally I/O-free except for the injected
// `linearFetch` function. The resolver does NOT import the receiver, the
// pi-sdk-runner, or any Slack/Linear SDK directly — wiring is the integrator's
// job in Phase 3.

import { parseSlackPermalink } from "./slack-permalink.mjs";

// GraphQL document used by `linear_attachment_thread`. Kept in this module
// (rather than the skill) because it is part of the resolver's contract: the
// shape of the response (`issue.attachments.nodes[].url`) is what we depend on.
const ISSUE_ATTACHMENTS_QUERY = `query IssueAttachments($id: String!) {
  issue(id: $id) {
    id
    identifier
    attachments {
      nodes {
        id
        url
        title
      }
    }
  }
}`;

/**
 * Extract the Linear issue ID from a webhook event payload.
 *
 * Comment events carry the parent issue ID at `data.issueId`.
 * Issue events carry the issue ID at `data.id`.
 * Anything else returns `null`.
 *
 * @param {any} event
 * @returns {string | null}
 */
function extractIssueId(event) {
  const data = event?.data;
  if (!data || typeof data !== "object") return null;
  const type = event?.type;
  if (type === "Comment" && typeof data.issueId === "string") return data.issueId;
  if (type === "Issue" && typeof data.id === "string") return data.id;
  // Defensive fallback: prefer issueId (comment-shaped) over id (issue-shaped)
  // when type is missing/unknown but the payload is otherwise well-formed.
  if (typeof data.issueId === "string") return data.issueId;
  if (typeof data.id === "string") return data.id;
  return null;
}

/**
 * Strategy: resolve to the Slack thread captured as a Linear attachment on
 * the event's parent issue.
 *
 * @param {any} event - Linear webhook event (Comment or Issue shape).
 * @param {any} _route - Route config (unused here; fallback handled by caller).
 * @param {{linearFetch: Function, logger?: any}} deps
 * @returns {Promise<{channel: string, thread_ts: string} | null>}
 */
export async function resolveLinearAttachmentThread(event, _route, { linearFetch, logger = console } = {}) {
  if (typeof linearFetch !== "function") {
    logger?.warn?.("[destination-resolver] linearFetch not injected; cannot resolve linear_attachment_thread");
    return null;
  }
  const issueId = extractIssueId(event);
  if (!issueId) {
    logger?.warn?.("[destination-resolver] no issue id on event; cannot query attachments");
    return null;
  }

  let response;
  try {
    response = await linearFetch(ISSUE_ATTACHMENTS_QUERY, { id: issueId });
  } catch (err) {
    // Linear GraphQL convention: a network/throw is unusual but possible.
    // Swallow it — destination resolution is best-effort; the caller falls
    // back to `fallback_channel`. Never let a resolver throw.
    logger?.warn?.(`[destination-resolver] linearFetch threw: ${err?.message || String(err)}`);
    return null;
  }

  // Linear returns errors[] alongside data even on HTTP 200. Treat any error
  // as a soft failure and fall through.
  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    const msg = response.errors.map((e) => e?.message).filter(Boolean).join("; ");
    logger?.warn?.(`[destination-resolver] linearFetch returned errors: ${msg}`);
    return null;
  }

  const nodes = response?.data?.issue?.attachments?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  for (const node of nodes) {
    const parsed = parseSlackPermalink(node?.url);
    if (parsed) {
      return { channel: parsed.channel, thread_ts: parsed.thread_ts };
    }
  }
  return null;
}

/**
 * Strategy: static lookup table from a key on the event to a Slack channel.
 *
 * Stubbed for v1 — returns `null` unconditionally. The interface is here so
 * the integrator can wire route config without a second pass on this module.
 *
 * TODO(post-v1): pick a key extractor (e.g. `data.repo.full_name` for GitHub
 * events) and look it up in `route.destination.static_map`. Likely shape:
 *   static_map: { "owner/repo": "C123ABC", ... }
 *
 * @param {any} _event
 * @param {any} _route
 * @returns {null}
 */
export function resolveStaticMapping(_event, _route) {
  // Not implemented for v1. See TODO above.
  return null;
}

/**
 * Strategy: return the route's fallback channel with no thread anchor.
 *
 * Always returns either `{channel}` or `null` (when `fallback_channel` is not
 * configured). No I/O.
 *
 * @param {any} route
 * @returns {{channel: string} | null}
 */
export function resolveFallback(route) {
  const channel = route?.destination?.fallback_channel;
  if (typeof channel !== "string" || channel.length === 0) return null;
  return { channel };
}

const STRATEGIES = {
  linear_attachment_thread: resolveLinearAttachmentThread,
  static_mapping: resolveStaticMapping,
  fallback_channel: (_event, route) => resolveFallback(route),
};

/**
 * Factory for the destination resolver. The factory pattern matches
 * extensions/linear-graphql.ts so tests can inject a fake `linearFetch` and
 * `logger` without monkey-patching modules.
 *
 * `linearFetch` contract:
 *   async (query: string, variables: object) => { data?, errors? }
 *
 * It is up to the wiring layer (Phase 3) to adapt `linear_graphql`'s
 * tool-shaped response (`{content, details}`) into this `{data, errors}`
 * shape — typically by passing `details` through verbatim.
 *
 * @param {{linearFetch?: Function, logger?: any}} [opts]
 */
export function createDestinationResolver({ linearFetch, logger = console } = {}) {
  return {
    /**
     * Resolve a destination for `event` per `route.destination.resolver`.
     *
     * Returns `{channel, thread_ts?}` on success. If the chosen strategy
     * returns `null` and `route.destination.fallback_channel` is set, the
     * fallback channel is returned (no thread anchor). Returns `null` if no
     * destination can be resolved at all.
     *
     * @param {any} event
     * @param {any} route
     * @returns {Promise<{channel: string, thread_ts?: string} | null>}
     */
    resolve: async (event, route) => {
      const resolverName = route?.destination?.resolver;
      const strategy = resolverName ? STRATEGIES[resolverName] : undefined;
      if (!strategy) {
        logger?.warn?.(`[destination-resolver] unknown resolver strategy: ${String(resolverName)}`);
        return null;
      }

      let result;
      try {
        result = await strategy(event, route, { linearFetch, logger });
      } catch (err) {
        // Belt-and-braces: strategies are written to never throw, but if one
        // does we still want to fall through to the fallback rather than
        // bubble.
        logger?.warn?.(`[destination-resolver] strategy ${resolverName} threw: ${err?.message || String(err)}`);
        result = null;
      }

      if (result && typeof result.channel === "string") return result;

      // Strategy didn't produce a usable destination; try the fallback if the
      // route defines one. Resolver name === "fallback_channel" already went
      // through the same code path above; calling resolveFallback again here
      // is a no-op duplicate and intentional — it makes the strategy
      // independent of whether the caller picked it explicitly or implicitly.
      const fallback = resolveFallback(route);
      return fallback;
    },
  };
}
