// Pi custom tool for Linear. One tool, all operations.
//
//   linear_graphql — single entry point to Linear's GraphQL API. The model
//                    composes any query/mutation it needs; operational
//                    recipes, idempotency, and policy live in the
//                    `linear-graphql` skill, not in this tool.
//
// Replaces the previous trio (linear_search_issues / linear_create_issue /
// linear_add_comment). Net effect: ~430 LOC → ~80 LOC, and new Linear use
// cases (sub-issues, labels, cycles, attachments, state transitions, etc.)
// need only a SKILL.md edit — no new tool plumbing.
//
// Env contract:
//   LINEAR_API_KEY     required (personal API key style: NO `Bearer` prefix)
//   LINEAR_TEAM_ID     optional default (used by skill recipes as $teamId)
//   LINEAR_PROJECT_ID  optional default (used by skill recipes as $projectId)
//   LINEAR_STATE_ID    optional default (used by skill recipes as $stateId)
//   LINEAR_API_URL     optional override (default https://api.linear.app/graphql)
//
// Auth header gotcha: Linear's personal API key goes in `Authorization: <KEY>`
// with NO `Bearer` prefix. OAuth bearers DO use `Bearer <token>`. This tool
// targets personal API keys (LINEAR_API_KEY); flip the shape here if/when we
// wire OAuth.
//
// Rate limits: Linear returns HTTP 200 with `errors[].extensions.code =
// "RATELIMITED"` rather than a real HTTP 429. We surface that as isError so
// the model can back off or report it.
//
// Mutation safety: this tool is intentionally dumb. Mutation gating is
// delegated to extensions/linear-mcp-guard.ts, which inspects the `query`
// argument for the `\bmutation\b` token and routes through the same Slack
// approval flow used for proxied Linear MCP mutations. Keeping the guard in
// one place avoids double-confirmation and keeps tool code policy-free.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql";

function redactSecrets(text: string): string {
  return String(text || "")
    .replace(/lin_api_[A-Za-z0-9_-]+/g, "lin_api_[REDACTED]")
    .replace(/Authorization:\s*[^\s'"`]+/gi, "Authorization: [REDACTED]");
}

export interface LinearGraphqlOptions {
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
    content: [{ type: "text", text }],
    details: undefined,
    isError: true,
  };
}

export function createLinearGraphqlFactory({
  fetchImpl = fetch,
  env = process.env,
}: LinearGraphqlOptions = {}) {
  return function linearGraphql(pi: ExtensionAPI) {
    pi.registerTool({
      name: "linear_graphql",
      label: "Linear GraphQL",
      description:
        "Single entry point to Linear's GraphQL API. Post any query or mutation against https://api.linear.app/graphql. See the linear-graphql skill for recipes (search, get, create, comment) and policy (title clamp, env defaults, mutation safety).",
      promptSnippet:
        "linear_graphql: post arbitrary GraphQL to Linear. See the linear-graphql skill for recipes.",
      promptGuidelines: [
        "Load the linear-graphql skill before composing queries — recipes live there, not here.",
        "Pass GraphQL variables via the `variables` arg; never string-interpolate user input into `query`.",
        "Check the response for `errors[]` even on a 200 — GraphQL convention.",
        "Mutations require explicit user confirmation per ADR-0002; the guard enforces this.",
      ],
      parameters: Type.Object({
        query: Type.String({
          minLength: 1,
          description:
            "GraphQL query or mutation document. Use $variables for inputs — do not interpolate user data into the query string.",
        }),
        variables: Type.Optional(
          Type.Record(Type.String(), Type.Any(), {
            description: "Optional variables map for the GraphQL operation.",
          }),
        ),
        operationName: Type.Optional(
          Type.String({
            description: "Optional GraphQL operationName when the document contains multiple operations.",
          }),
        ),
      }),
      async execute(_toolCallId, params: any, signal) {
        const apiKey = env.LINEAR_API_KEY;
        if (!apiKey) {
          return errorResult(
            "LINEAR_API_KEY is not set in the bot environment; cannot call Linear. Tell the user to set the env var.",
          );
        }
        const apiUrl = env.LINEAR_API_URL || DEFAULT_LINEAR_API_URL;
        const query = String(params?.query || "");
        const variables = (params?.variables && typeof params.variables === "object") ? params.variables : undefined;
        const operationName = typeof params?.operationName === "string" && params.operationName.length > 0
          ? params.operationName
          : undefined;

        try {
          const response = await fetchImpl(apiUrl, {
            method: "POST",
            headers: {
              // Personal API key style: NO `Bearer` prefix. Flipping this for
              // OAuth tokens would mean `Bearer ${token}`.
              Authorization: apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query, variables, operationName }),
            signal,
          });

          const payload: any = await response.json().catch(() => ({}));
          const errors: any[] = Array.isArray(payload?.errors) ? payload.errors : [];
          const hasErrors = errors.length > 0;
          const rateLimited = errors.some((e) => e?.extensions?.code === "RATELIMITED");

          // Surface the full payload (data + errors + extensions) verbatim so
          // the model can reason over whatever shape it asked for. The tool
          // itself does not parse or reshape responses.
          const detailsPayload: Record<string, unknown> = {};
          if (payload?.data !== undefined) detailsPayload.data = payload.data;
          if (hasErrors) detailsPayload.errors = errors;
          if (payload?.extensions !== undefined) detailsPayload.extensions = payload.extensions;

          if (!response.ok || hasErrors) {
            const reasonRaw = errors.map((e: any) => e?.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
            const reason = redactSecrets(reasonRaw);
            const codes = errors.map((e: any) => e?.extensions?.code).filter(Boolean);
            const codeSuffix = codes.length ? ` [${codes.join(",")}]` : "";
            const text = rateLimited
              ? `Linear rate-limited the request${codeSuffix}: ${reason}. Back off (Linear allows 5000 req/hr + 3M complexity pts/hr on API keys) and retry after a delay.`
              : `Linear GraphQL error${codeSuffix}: ${reason}`;
            return {
              content: [{ type: "text", text }],
              details: detailsPayload,
              isError: true,
            };
          }

          // Happy path — return the data verbatim. The text channel gives the
          // model a quick scan; details has the full shape.
          const dataKeys = payload?.data && typeof payload.data === "object" ? Object.keys(payload.data) : [];
          return {
            content: [
              {
                type: "text",
                text: dataKeys.length
                  ? `Linear GraphQL OK. Top-level data fields: ${dataKeys.join(", ")}.`
                  : "Linear GraphQL OK (empty data payload).",
              },
            ],
            details: detailsPayload,
          };
        } catch (err: any) {
          if (err?.name === "AbortError") {
            return errorResult("Linear GraphQL request aborted before completion.");
          }
          return errorResult(`Linear GraphQL request error: ${redactSecrets(err?.message || String(err))}`);
        }
      },
    });
  };
}

// Default export uses real fetch + process.env so pi-sdk-runner can pass the
// factory straight into DefaultResourceLoader.extensionFactories.
export default createLinearGraphqlFactory();
