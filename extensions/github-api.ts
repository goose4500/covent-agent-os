// Pi custom tool: a single entry point to GitHub for the model. Two API
// surfaces (REST + GraphQL) live behind one tool, routed by the `path` arg —
// mirroring the mental model of the `gh api` CLI so the model already knows
// the shape.
//
//   github_api  — Issue any REST request (path like "/repos/{owner}/{repo}/pulls")
//                 OR a GraphQL request (path === "graphql"). Method defaults to
//                 GET for REST; GraphQL is always POST.
//
// Why one tool, not many: GitHub has hundreds of endpoints. Surfacing one
// generic tool + a fundamentals skill (skills/github-api/SKILL.md) lets the
// model use the API at its full breadth without us hand-rolling 30 narrow
// wrappers. The skill carries the recipes; this file is the transport.
//
// Env contract:
//   GITHUB_TOKEN     required (fine-grained PAT preferred; Bearer auth header)
//   GITHUB_API_URL   optional override for GitHub Enterprise (default
//                    https://api.github.com)
//
// Error model:
//   - Missing env → AgentToolResult { isError: true } with a redacted reason
//   - REST non-2xx → isError, parsed body preserved in details
//   - GraphQL errors[] non-empty → isError, both data and errors preserved
//   - 403/429 with Retry-After → isError, Retry-After surfaced in message
//   - AbortSignal → isError, "GitHub request aborted"
//
// Mutation classification:
//   - REST: method ∈ {POST, PATCH, PUT, DELETE} → details.mutation = true
//   - GraphQL: body.query matches /\bmutation\b/i  → details.mutation = true
//   This tool is intentionally "dumb" and never prompts on writes — gating
//   lives in a sibling guard extension that can read `details.mutation` on
//   the tool_call event. See extensions/linear-mcp-guard.ts for the shape.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

type AnyResult = {
  content: Array<{ type: "text"; text: string }>;
  details: any;
  isError?: boolean;
};

function errorResult(text: string, details?: any): AnyResult {
  return {
    content: [{ type: "text", text }],
    details,
    isError: true,
  };
}

// Redact token-like fragments. GitHub tokens use prefixes gh{p,o,u,s,r}_…
// (PATs, OAuth, user-to-server, server-to-server, refresh) and ghs_… for
// server tokens. We deliberately do NOT length-check tokens — the format is
// mid-rollout May-June 2026, growing from 40 chars to ~520; pattern-matching
// on length would break new tokens silently.
function redactSecrets(text: string): string {
  return String(text || "")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "gh*_[REDACTED]")
    .replace(/ghs_[A-Za-z0-9_]+/g, "ghs_[REDACTED]")
    .replace(/Authorization:\s*[^\s'"`]+/gi, "Authorization: [REDACTED]");
}

function isGraphqlPath(path: string): boolean {
  return path === "graphql" || path === "/graphql";
}

function isMutationGraphql(query: unknown): boolean {
  return typeof query === "string" && /\bmutation\b/i.test(query);
}

function classifyMutation(args: {
  graphql: boolean;
  method: string;
  body: any;
}): boolean {
  if (args.graphql) return isMutationGraphql(args.body?.query);
  const m = args.method.toUpperCase();
  return m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE";
}

function buildUrl(base: string, path: string): string {
  if (isGraphqlPath(path)) {
    // GraphQL endpoint is fixed at /graphql on whatever base host is in use.
    return `${base.replace(/\/+$/, "")}/graphql`;
  }
  const trimmed = base.replace(/\/+$/, "");
  return path.startsWith("/") ? `${trimmed}${path}` : `${trimmed}/${path}`;
}

export interface GithubApiOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export function createGithubApiFactory({
  fetchImpl = fetch,
  env = process.env,
}: GithubApiOptions = {}) {
  return function githubApi(pi: ExtensionAPI) {
    pi.registerTool({
      name: "github_api",
      label: "Call GitHub API",
      description:
        "Single entry point to GitHub. REST or GraphQL routed by the path arg. See github-api skill for recipes.",
      promptSnippet:
        "github_api: call any GitHub REST endpoint, or send a GraphQL query/mutation by setting path to 'graphql'.",
      promptGuidelines: [
        "Default to REST. Use GraphQL (path='graphql') only for Projects v2, stitched PR-state queries, advanced issue search, or sub-issues.",
        "Body must be a JSON object. For GraphQL pass {query, variables?}.",
        "REST: non-2xx is failure (parse body). GraphQL: always 200, check errors[].",
        "Writes (non-GET REST + GraphQL mutations) may be gated by project policy; expect to be denied or prompted in non-interactive surfaces.",
        "Respect Retry-After on 403/429 from secondary rate limits.",
      ],
      parameters: Type.Object({
        method: Type.Optional(
          Type.String({
            description:
              "HTTP verb for REST (GET, POST, PATCH, PUT, DELETE). Ignored when path is 'graphql' (always POST). Defaults to GET.",
          }),
        ),
        path: Type.String({
          minLength: 1,
          description:
            "REST resource path starting with '/' (e.g. '/repos/{owner}/{repo}/pulls/123') OR the literal 'graphql' to route to the GraphQL endpoint.",
        }),
        body: Type.Optional(
          Type.Object(
            {},
            {
              additionalProperties: true,
              description:
                "JSON body. For GraphQL must be {query, variables?}. For REST, the request body for POST/PATCH/PUT/DELETE.",
            },
          ),
        ),
        headers: Type.Optional(
          Type.Object(
            {},
            {
              additionalProperties: true,
              description:
                "Extra request headers merged over the defaults (caller wins). Use this to opt into feature flags like 'GraphQL-Features: sub_issues'.",
            },
          ),
        ),
      }),
      async execute(_toolCallId, params: any, signal) {
        const token = env.GITHUB_TOKEN;
        if (!token) {
          return errorResult(
            "GITHUB_TOKEN is not set in the bot environment; cannot call GitHub. Tell the user to set the env var.",
          );
        }

        const path = String(params.path || "").trim();
        if (!path) {
          return errorResult("github_api: `path` is required.");
        }
        const graphql = isGraphqlPath(path);
        const method = graphql
          ? "POST"
          : String(params.method || "GET").toUpperCase();
        const body = (params.body && typeof params.body === "object") ? params.body : undefined;
        const extraHeaders =
          params.headers && typeof params.headers === "object" ? params.headers : {};

        const base = env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL;
        const url = buildUrl(base, path);

        const defaultHeaders: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        };
        if (body !== undefined) defaultHeaders["Content-Type"] = "application/json";
        const headers: Record<string, string> = { ...defaultHeaders, ...extraHeaders };

        const mutation = classifyMutation({ graphql, method, body });

        const init: RequestInit = { method, headers, signal };
        if (body !== undefined) {
          init.body = JSON.stringify(body);
        }

        let response: Response;
        try {
          response = await fetchImpl(url, init);
        } catch (err: any) {
          if (err?.name === "AbortError") {
            return errorResult("GitHub request aborted before completion.", {
              mutation,
              url,
              method,
            });
          }
          return errorResult(
            `GitHub request error: ${redactSecrets(err?.message || String(err))}`,
            { mutation, url, method },
          );
        }

        const status = response.status;
        const retryAfter = response.headers?.get?.("retry-after") ?? null;
        const respHeaders = headersToObject(response.headers);

        // Parse body — JSON when content-type says so, otherwise text. We
        // tolerate empty bodies (e.g. 204 No Content).
        const contentType = response.headers?.get?.("content-type") || "";
        let parsedBody: any = null;
        const rawText = await response.text().catch(() => "");
        if (rawText) {
          if (contentType.includes("application/json")) {
            try { parsedBody = JSON.parse(rawText); } catch { parsedBody = rawText; }
          } else {
            parsedBody = rawText;
          }
        }

        // Secondary rate-limit shape: 403 or 429 with a Retry-After header.
        if ((status === 403 || status === 429) && retryAfter) {
          return errorResult(
            `GitHub ${method} ${path} hit a rate limit (HTTP ${status}). Retry-After: ${retryAfter}s. ${redactSecrets(summarizeBody(parsedBody))}`,
            { mutation, url, method, status, retryAfter, headers: respHeaders, body: parsedBody },
          );
        }

        if (graphql) {
          // GraphQL: always 200 on transport success; check errors[] in body.
          if (!response.ok) {
            return errorResult(
              `GitHub GraphQL transport failure: HTTP ${status} ${redactSecrets(summarizeBody(parsedBody))}`,
              { mutation, url, method, status, headers: respHeaders, body: parsedBody },
            );
          }
          const data = parsedBody && typeof parsedBody === "object" ? parsedBody.data ?? null : null;
          const errors = parsedBody && typeof parsedBody === "object" && Array.isArray(parsedBody.errors)
            ? parsedBody.errors
            : [];
          if (errors.length > 0) {
            const reason = errors.map((e: any) => e?.message).filter(Boolean).join("; ") || "GraphQL error";
            return errorResult(
              `GitHub GraphQL returned errors: ${redactSecrets(reason)}`,
              { mutation, url, method, status, headers: respHeaders, data, errors },
            );
          }
          return {
            content: [
              {
                type: "text",
                text: `GitHub GraphQL OK (${status}).${mutation ? " [mutation]" : ""}`,
              },
            ],
            details: { mutation, url, method, status, headers: respHeaders, data, errors },
          };
        }

        // REST: non-2xx is failure.
        if (!response.ok) {
          return errorResult(
            `GitHub ${method} ${path} failed: HTTP ${status} ${redactSecrets(summarizeBody(parsedBody))}`,
            { mutation, url, method, status, headers: respHeaders, body: parsedBody },
          );
        }

        return {
          content: [
            {
              type: "text",
              text: `GitHub ${method} ${path} OK (${status}).${mutation ? " [mutation]" : ""}`,
            },
          ],
          details: { mutation, url, method, status, headers: respHeaders, body: parsedBody },
        };
      },
    });
  };
}

function headersToObject(h: any): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!h) return out;
    if (typeof h.forEach === "function") {
      h.forEach((value: string, key: string) => { out[key] = value; });
      return out;
    }
    if (typeof h.entries === "function") {
      for (const [k, v] of h.entries()) out[k] = String(v);
    }
  } catch { /* noop */ }
  return out;
}

function summarizeBody(body: any): string {
  if (body == null) return "";
  if (typeof body === "string") return body.length > 400 ? `${body.slice(0, 400)}…` : body;
  try {
    const s = JSON.stringify(body);
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch {
    return String(body);
  }
}

// Default export uses real fetch + process.env so pi-sdk-runner can pass the
// factory straight into DefaultResourceLoader.extensionFactories without
// configuration.
export default createGithubApiFactory();
