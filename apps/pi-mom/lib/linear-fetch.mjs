// In-process Linear GraphQL fetch adapter for the event-driven Pi runtime
// (issue #48, phase 3).
//
// The destination resolver's `linearFetch` contract is:
//   async (query: string, variables: object) => { data?, errors? }
//
// This adapter calls https://api.linear.app/graphql directly — it does NOT go
// through the agent's `linear_graphql` tool. The resolver runs BEFORE the
// agent is invoked (we need a Slack destination to even build the synthetic
// turn), so the agent runtime isn't available; and dropping into a direct
// HTTP call is simpler than spinning up a one-shot session.
//
// Auth header gotcha: Linear's personal API key goes in `Authorization: <KEY>`
// with NO `Bearer` prefix. OAuth bearers DO use `Bearer <token>`. We target
// personal API keys via LINEAR_API_KEY — same posture as extensions/linear-graphql.ts.
//
// Errors are returned as `{errors:[{message}]}` rather than thrown, because the
// destination resolver treats any error/network failure as a soft fallback to
// the configured fallback channel. Throwing here would force every caller to
// wrap in try/catch; returning the GraphQL error shape keeps the contract
// uniform across happy and sad paths.

const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql";

/**
 * Create a `linearFetch(query, variables)` function bound to the given API key
 * and base URL. The defaults read process.env so a caller can construct one
 * without arguments in the production boot path.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiKey] - Linear personal API key (defaults to env)
 * @param {string} [opts.apiUrl] - GraphQL endpoint URL (defaults to env or Linear's prod URL)
 * @param {typeof fetch} [opts.fetchImpl] - injected for tests
 * @returns {(query: string, variables?: object) => Promise<{data?: any, errors?: any[]}>}
 */
export function createLinearFetch({
  apiKey = process.env.LINEAR_API_KEY,
  apiUrl = process.env.LINEAR_API_URL || DEFAULT_LINEAR_API_URL,
  fetchImpl = fetch,
} = {}) {
  return async function linearFetch(query, variables) {
    if (!apiKey) {
      return {
        errors: [
          { message: "LINEAR_API_KEY not set; cannot resolve Linear destinations" },
        ],
      };
    }
    try {
      const response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          // Personal API key style: NO `Bearer` prefix. Mirrors
          // extensions/linear-graphql.ts so behavior matches the agent tool.
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      const payload = await response.json().catch(() => ({}));
      // Return whatever the API gave us. The resolver only inspects `data` and
      // `errors`, but passing through `extensions` etc. keeps the shape honest.
      return payload && typeof payload === "object" ? payload : {};
    } catch (err) {
      return {
        errors: [{ message: `linearFetch network error: ${err?.message || String(err)}` }],
      };
    }
  };
}
