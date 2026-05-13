// Pi custom tool for GitHub. One tool, two surfaces (REST + GraphQL).
//
//   github_api — single entry point routed by the `path` arg: REST when
//                path looks like a resource (`/repos/...`), GraphQL when
//                path === "graphql"|"/graphql". Mirrors the `gh api` CLI's
//                mental model. Recipes and policy live in the `github-api`
//                skill, not in this tool.
//
// Env contract:
//   GITHUB_TOKEN     required (Bearer auth header; tokens are opaque)
//   GITHUB_API_URL   optional override for GitHub Enterprise (default
//                    https://api.github.com)
//
// Mutation classification: REST methods in {POST,PATCH,PUT,DELETE} and
// GraphQL documents matching /\bmutation\b/i are surfaced as
// `details.mutation = true` for a sibling guard (see linear-mcp-guard.ts
// shape) to gate on. This tool never prompts.
//
// Not in scope: GitHub App JWT mint flow, Projects v2 recipe set, webhook
// receivers — see skills/github-api/SKILL.md "Future".

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

// Token prefixes: gh{p,o,u,s,r}_ (PAT/OAuth/user-to-server/server/refresh) +
// ghs_ server tokens. Deliberately no length check — the token format is
// mid-rollout May–June 2026 and the byte length is growing.
function redactSecrets(text: string): string {
  return String(text || "")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "gh*_[REDACTED]")
    .replace(/ghs_[A-Za-z0-9_]+/g, "ghs_[REDACTED]")
    .replace(/Authorization:\s*[^\s'"`]+/gi, "Authorization: [REDACTED]");
}

function isGraphqlPath(path: string): boolean {
  return path === "graphql" || path === "/graphql";
}

function isMutation(graphql: boolean, method: string, body: any): boolean {
  if (graphql) return typeof body?.query === "string" && /\bmutation\b/i.test(body.query);
  const m = method.toUpperCase();
  return m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE";
}

function buildUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (isGraphqlPath(path)) return `${trimmed}/graphql`;
  return path.startsWith("/") ? `${trimmed}${path}` : `${trimmed}/${path}`;
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

export interface GithubApiOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

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
        if (!path) return errorResult("github_api: `path` is required.");

        const graphql = isGraphqlPath(path);
        const method = graphql ? "POST" : String(params.method || "GET").toUpperCase();
        const body = (params.body && typeof params.body === "object") ? params.body : undefined;
        const extraHeaders = params.headers && typeof params.headers === "object" ? params.headers : {};

        const base = env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL;
        const url = buildUrl(base, path);

        const defaultHeaders: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        };
        if (body !== undefined) defaultHeaders["Content-Type"] = "application/json";
        const headers: Record<string, string> = { ...defaultHeaders, ...extraHeaders };

        const mutation = isMutation(graphql, method, body);

        const init: RequestInit = { method, headers, signal };
        if (body !== undefined) init.body = JSON.stringify(body);

        let response: Response;
        try {
          response = await fetchImpl(url, init);
        } catch (err: any) {
          if (err?.name === "AbortError") {
            return errorResult("GitHub request aborted before completion.", { mutation, url, method });
          }
          return errorResult(
            `GitHub request error: ${redactSecrets(err?.message || String(err))}`,
            { mutation, url, method },
          );
        }

        const status = response.status;
        const retryAfter = response.headers?.get?.("retry-after") ?? null;
        const respHeaders = headersToObject(response.headers);

        // Tolerate empty bodies (e.g. 204 No Content); fall back to text when
        // content-type isn't JSON so error pages still surface verbatim.
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

        // Secondary rate-limit shape: 403 or 429 with Retry-After. Surface
        // verbatim and bail — never auto-retry.
        if ((status === 403 || status === 429) && retryAfter) {
          return errorResult(
            `GitHub ${method} ${path} hit a rate limit (HTTP ${status}). Retry-After: ${retryAfter}s. ${redactSecrets(summarizeBody(parsedBody))}`,
            { mutation, url, method, status, retryAfter, headers: respHeaders, body: parsedBody },
          );
        }

        if (graphql) {
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
            content: [{ type: "text", text: `GitHub GraphQL OK (${status}).${mutation ? " [mutation]" : ""}` }],
            details: { mutation, url, method, status, headers: respHeaders, data, errors },
          };
        }

        if (!response.ok) {
          return errorResult(
            `GitHub ${method} ${path} failed: HTTP ${status} ${redactSecrets(summarizeBody(parsedBody))}`,
            { mutation, url, method, status, headers: respHeaders, body: parsedBody },
          );
        }

        return {
          content: [{ type: "text", text: `GitHub ${method} ${path} OK (${status}).${mutation ? " [mutation]" : ""}` }],
          details: { mutation, url, method, status, headers: respHeaders, body: parsedBody },
        };
      },
    });
  };
}

// Default export uses real fetch + process.env so pi-sdk-runner can pass the
// factory straight into DefaultResourceLoader.extensionFactories.
export default createGithubApiFactory();
