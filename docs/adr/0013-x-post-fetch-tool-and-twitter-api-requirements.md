# ADR 0013: X post fetch tool — Twitter API v2 token requirements and credit tier

Date: 2026-05-16
Status: accepted
Related: PR #129 (x-fetch-post-tool), ADR 0011 (native Pi tools for high-leverage MCP workflows)

## Context

PR #129 shipped `x_fetch_post`, a native Pi tool that looks up X/Twitter posts by URL or tweet ID using the X API v2. The tool calls `https://api.twitter.com/2/tweets/:id` with `expansions=author_id,attachments.media_keys`, normalizes the response (author name, text, best video variant, photos), and returns a structured result the model can reason over without a browser.

During initial live testing, the API returned `CreditsDepleted` immediately after authentication succeeded. This revealed a non-obvious gap between two distinct X/xAI products that share the letter "X" in their branding.

### The two APIs — not interchangeable

| | X/Twitter REST API v2 | xAI API |
|---|---|---|
| **Vendor** | X Corp (twitter.com) | xAI (x.ai) |
| **Auth token prefix** | `AAAAAAAAAA…` (Bearer token) | Managed via Pi `auth.json` under the `xai` provider |
| **What it does** | Fetches tweets, user profiles, media from X's social graph | Runs Grok language models (inference only) |
| **Railway env var** | `X_API_BEARER_TOKEN` | N/A — loaded from Pi auth volume |
| **Pi SDK role** | External REST credential for `x_fetch_post` tool | Model provider for Pi sessions (`xai/grok-*`) |

The xAI key stored in `~/.pi/agent/auth.json` under provider `xai` cannot be substituted for `X_API_BEARER_TOKEN`. They authenticate to completely different services. Attempting this substitution would result in a `401 Unauthorized` from the Twitter API, not a credit error.

### Credit tier behavior

X Developer Apps are gated by a monthly read-credit quota that resets on the first of each month. The tier tiers as of 2026:

| Tier | Monthly tweet reads | Price |
|------|-------------------|-------|
| Free | 500 reads | $0 |
| Basic | 10,000 reads | $100/mo |
| Pro | 1,000,000 reads | $5,000/mo |

The Bearer token (`X_API_BEARER_TOKEN`) set on the Railway service belongs to an app on the **Free tier**. The `CreditsDepleted` error is expected behavior when the 500-read cap is exhausted within a calendar month. The authentication succeeds (token is valid, 112 chars); only the quota is empty.

### What the tool does when credits are available

The `x_fetch_post` tool (`extensions/x-fetch-post-tool.ts`, client at `lib/x-api-client.mjs`):

1. Accepts either a full `https://x.com/user/status/:id` URL or a raw tweet ID
2. Calls `GET /2/tweets/:id` with `expansions=author_id,attachments.media_keys&tweet.fields=created_at,public_metrics,entities&user.fields=name,username&media.fields=type,url,variants`
3. Normalizes the response: `{ id, text, author: { name, username }, createdAt, media: [{ type, url }], metrics: { likes, retweets, replies, quotes } }`
4. Returns `isError: true` with a clear message when `X_API_BEARER_TOKEN` is unset or the API returns a non-200 status
5. Redacts any `X_API_BEARER_TOKEN`-shaped value from error text before it reaches Slack

Test coverage lives in `apps/pi-mom/test-x-api-client.mjs` (URL parsing, lookup URL construction, response normalization, token fallback, error paths).

## Decision

Ship `x_fetch_post` as a native Pi tool now. Accept that it is non-functional until the X Developer App is upgraded beyond the Free tier or the monthly credit cycle resets. The tool degrades gracefully — it returns `isError: true` with a clear "credits depleted" message; Pi reports this to the user rather than hanging or crashing.

Do not substitute the xAI API key for the Twitter API Bearer token. They are unrelated products.

## Consequences

- `x_fetch_post` is deployed and wired to `X_API_BEARER_TOKEN` on Railway. The token is valid.
- The tool returns a clean error message when credits are exhausted — the model surfaces this as "the X API credit quota is exhausted; fetch will work again on the 1st or once the app is upgraded to Basic tier."
- **To enable the tool**: upgrade the X Developer App at `developer.twitter.com` to Basic ($100/mo) or create a new app under the same developer account (each app gets its own quota).

## Follow-ups

1. **Rotate `X_API_BEARER_TOKEN`** — the current token was pasted in a chat session and is now in conversation history. Generate a new Bearer token at `developer.x.com/apps` and update the Railway env var before the account is used for any sensitive workloads.
2. **Upgrade or new app** — decide whether to upgrade the existing app to Basic tier or create a second X Developer App with a fresh Free-tier quota. A second app is faster but shares the same 500-read monthly cap; Basic is the durable fix.
3. **Add `sk-or-v1-` prefix to redaction patterns** — `lib/redaction.mjs` does not currently redact OpenRouter API key shapes. See ADR 0014.
