// Pi custom tool for the Slack Web API. One tool, all methods.
//
//   slack_api — single entry point to https://slack.com/api/<method>. The
//               model picks the method + params; the tool enforces the
//               allowlist, picks the right token (bot vs user), and surfaces
//               ok/error/rate-limit signals. Recipes and policy live in the
//               `slack-api` skill, not in this tool.
//
// Env contract:
//   SLACK_BOT_TOKEN          required — xoxb- bot token (covers ~95% of methods)
//   SLACK_USER_TOKEN         optional — xoxp- user token; selected when the
//                            model passes as_user:true (search.* etc.)
//   SLACK_METHOD_ALLOWLIST   optional CSV — overrides DEFAULT_ALLOWLIST.
//
// Mutation classification: write-verb methods (chat.postMessage, reactions.add,
// pins.add, ...) are surfaced as `details.mutation = true` for a sibling guard
// to consume (extensions/slack-mcp-guard.ts gates the MCP path today; a future
// slack-api-guard.ts can mirror it for the native path). The allowlist is the
// v1 safety floor.
//
// Not in scope: files.* upload (the 3-step replacement for the dead
// files.upload is deferred), canvas/list writes, scheduled messages.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_SLACK_API_URL = "https://slack.com/api";

// v1 allowlist: ~25 high-signal methods covering thread reads/writes,
// channel/user lookup, search, reactions, pins, bookmarks. Anything outside
// requires the operator to opt in via SLACK_METHOD_ALLOWLIST.
const DEFAULT_ALLOWLIST: ReadonlyArray<string> = [
  // Reads
  "auth.test",
  "conversations.list",
  "conversations.info",
  "conversations.history",
  "conversations.replies",
  "users.info",
  "users.list",
  "users.lookupByEmail",
  "chat.getPermalink",
  "search.messages",
  "search.files",
  "team.info",
  "bookmarks.list",
  "pins.list",
  "reactions.get",
  // Writes (also in MUTATION_METHODS below)
  "chat.postMessage",
  "chat.update",
  "chat.delete",
  "reactions.add",
  "reactions.remove",
  "pins.add",
  "pins.remove",
  "bookmarks.add",
  "conversations.invite",
];

// Exact-match write set. Classify by method name (not heuristics) because the
// cost of a misclassified write is "silent post"; cost of a misclassified read
// is "needless confirm".
const MUTATION_METHODS: ReadonlySet<string> = new Set([
  "chat.postMessage",
  "chat.update",
  "chat.delete",
  "reactions.add",
  "reactions.remove",
  "pins.add",
  "pins.remove",
  "bookmarks.add",
  "conversations.invite",
]);

function redactSecrets(text: string): string {
  return String(text || "")
    .replace(/xox[abprs]-[A-Za-z0-9-]+/g, "xox[REDACTED]")
    .replace(/Authorization:\s*[^\s'"`]+/gi, "Authorization: [REDACTED]");
}

function parseAllowlist(csv: string | undefined): ReadonlyArray<string> {
  if (!csv) return DEFAULT_ALLOWLIST;
  const parts = csv.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : DEFAULT_ALLOWLIST;
}

export interface SlackApiOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

type AnyResult = {
  content: Array<{ type: "text"; text: string }>;
  details: any;
  isError?: boolean;
};

function errorResult(text: string): AnyResult {
  return {
    content: [{ type: "text", text: redactSecrets(text) }],
    details: undefined,
    isError: true,
  };
}

function summarize(method: string, payload: any): string {
  if (method === "chat.postMessage" || method === "chat.update") {
    return `Slack ${method} ok (ts=${payload?.ts ?? "?"} channel=${payload?.channel ?? "?"}).`;
  }
  if (method === "chat.delete") {
    return `Slack chat.delete ok (ts=${payload?.ts ?? "?"} channel=${payload?.channel ?? "?"}).`;
  }
  if (method === "auth.test") {
    return `auth.test ok (team=${payload?.team ?? "?"} user=${payload?.user ?? "?"} bot_id=${payload?.bot_id ?? "?"}).`;
  }
  if (method === "conversations.replies" || method === "conversations.history") {
    const n = Array.isArray(payload?.messages) ? payload.messages.length : 0;
    return `${method} ok (${n} message${n === 1 ? "" : "s"}).`;
  }
  if (method === "users.lookupByEmail" || method === "users.info") {
    const u = payload?.user;
    return `${method} ok (user=${u?.id ?? "?"} name=${u?.name ?? u?.profile?.real_name ?? "?"}).`;
  }
  if (method === "search.messages") {
    const total = payload?.messages?.total ?? 0;
    return `search.messages ok (${total} hit${total === 1 ? "" : "s"}).`;
  }
  return `Slack ${method} ok.`;
}

export function createSlackApiFactory({
  fetchImpl = fetch,
  env = process.env,
}: SlackApiOptions = {}) {
  return function slackApi(pi: ExtensionAPI) {
    pi.registerTool({
      name: "slack_api",
      label: "Slack Web API",
      description:
        "Single entry point to the Slack Web API. Use this to read or write Slack from inside Pi. See the slack-api skill for the method catalog (chat.postMessage, conversations.replies, users.lookupByEmail, search.messages, ...) and copy-pasteable recipes. The bot token (SLACK_BOT_TOKEN) covers ~95% of methods; pass as_user:true to use SLACK_USER_TOKEN for search.* and other user-scoped methods. Method calls outside the configured allowlist are rejected; writes are surfaced for the guard layer.",
      promptSnippet:
        "slack_api: single tool that calls any Slack Web API method (chat.postMessage, conversations.replies, search.messages, ...).",
      promptGuidelines: [
        "Before chat.postMessage in a thread, call conversations.replies first to avoid duplicate replies (idempotency).",
        "Respect chat.postMessage's 1/sec/channel rate cap; never post twice to the same thread_ts in a single turn.",
        "On a 429, the tool surfaces Retry-After; do NOT tight-loop — back off or hand control back to the user.",
        "Set as_user:true ONLY when the method requires a user token (search.*) or when the user explicitly asks to act as themselves.",
        "When ok:false comes back, inspect .error (e.g. not_in_channel, missing_scope, channel_not_found, ratelimited) and either fix the call or explain to the user.",
      ],
      parameters: Type.Object({
        method: Type.String({
          minLength: 1,
          description:
            "Slack Web API method name, e.g. 'chat.postMessage' or 'conversations.replies'. Must be in the configured allowlist.",
        }),
        params: Type.Optional(
          Type.Object(
            {},
            {
              additionalProperties: true,
              description:
                "JSON body for the Slack method. Keys vary per method — see the slack-api skill recipes. Defaults to {}.",
            },
          ),
        ),
        as_user: Type.Optional(
          Type.Boolean({
            description:
              "If true, authenticate with SLACK_USER_TOKEN (xoxp-) instead of SLACK_BOT_TOKEN (xoxb-). Required for search.* and a few user-scoped methods. Defaults to false.",
          }),
        ),
      }),
      async execute(_toolCallId, params: any, signal) {
        const method = String(params?.method || "").trim();
        const body = (params?.params && typeof params.params === "object") ? params.params : {};
        const asUser = params?.as_user === true;

        if (!method) {
          return errorResult("method is required (e.g. 'chat.postMessage').");
        }

        const allowlist = parseAllowlist(env.SLACK_METHOD_ALLOWLIST);
        if (!allowlist.includes(method)) {
          return errorResult(
            `Method "${method}" not in allowlist. Add to SLACK_METHOD_ALLOWLIST to enable.`,
          );
        }

        const isMutation = MUTATION_METHODS.has(method);

        // Fail closed on missing token and name the env var so the user can
        // fix it without us echoing a secret back.
        const token = asUser ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN;
        if (!token) {
          const which = asUser ? "SLACK_USER_TOKEN" : "SLACK_BOT_TOKEN";
          return errorResult(
            `${which} is not set in the bot environment; cannot call Slack ${method}. Tell the user to set the env var.`,
          );
        }

        const url = `${DEFAULT_SLACK_API_URL}/${method}`;
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal,
          });
        } catch (err: any) {
          if (err?.name === "AbortError") {
            return errorResult(`Slack ${method} request aborted before completion.`);
          }
          return errorResult(`Slack ${method} request error: ${err?.message || String(err)}`);
        }

        // Real HTTP 429 is rare (most rate limits come back as ok:false /
        // "ratelimited") but tier-1 methods do trip it. Surface Retry-After
        // verbatim; the caller decides whether to back off or escalate.
        if (response.status === 429) {
          const retryAfter = response.headers?.get?.("retry-after") || "unknown";
          return errorResult(
            `Slack ${method} rate-limited (HTTP 429). Retry-After: ${retryAfter} seconds. Do NOT retry in a tight loop.`,
          );
        }

        let payload: any;
        try {
          payload = await response.json();
        } catch {
          payload = {};
        }

        if (!response.ok) {
          return errorResult(
            `Slack ${method} HTTP ${response.status}: ${typeof payload === "object" ? JSON.stringify(payload).slice(0, 400) : String(payload)}`,
          );
        }

        if (!payload || payload.ok !== true) {
          const code = payload?.error || "unknown_error";
          const messages = payload?.response_metadata?.messages;
          const detail = Array.isArray(messages) && messages.length > 0 ? ` (${messages.join("; ")})` : "";
          return errorResult(`Slack ${method} ok:false — ${code}${detail}`);
        }

        return {
          content: [{ type: "text", text: summarize(method, payload) }],
          details: { method, mutation: isMutation, as_user: asUser, response: payload },
        };
      },
    });
  };
}

// Default export uses real fetch + process.env so pi-sdk-runner can pass the
// factory straight into DefaultResourceLoader.extensionFactories.
export default createSlackApiFactory();

// Test hook: lets the test file exercise the helpers without going through
// registerTool's typebox machinery.
export const __slackApiTest = {
  DEFAULT_ALLOWLIST,
  MUTATION_METHODS,
  redactSecrets,
  parseAllowlist,
};
