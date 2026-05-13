// Pi custom tools for Linear. Three tools, all model-invoked via the Pi SDK
// tool surface:
//
//   linear_search_issues  — find existing issues that may already cover the
//                           current Slack thread's topic. Lets the model do
//                           "search before create" idempotency in its own
//                           reasoning instead of a bolted-on thread scan.
//   linear_create_issue   — create a new Linear issue (title, Markdown
//                           description, optional priority).
//   linear_add_comment    — add a comment to an existing Linear issue. Used
//                           when search finds a match and the right move is
//                           to attach context rather than create a duplicate.
//
// Composability is the win: the model can chain search → comment-or-create
// in a single turn instead of the bot routing to a single fixed Linear
// behavior per Slack message.
//
// Env contract:
//   LINEAR_API_KEY     required (Bearer-style header)
//   LINEAR_TEAM_ID     required for create + optional filter on search
//   LINEAR_PROJECT_ID  optional (default project for created issues)
//   LINEAR_STATE_ID    optional (initial workflow state)
//   LINEAR_API_URL     optional override (default https://api.linear.app/graphql)
//
// Error model (all tools):
//   - Missing env → AgentToolResult { isError: true } with a clear text reason
//   - HTTP / GraphQL failures → isError, redacted error message
//   - AbortSignal → isError, "Linear request aborted"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql";

const ISSUE_CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier title url }
    }
  }
`;

const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id url body }
    }
  }
`;

// Linear's text search lives at the `issues` connection with a filter +
// `orderBy`. We use the `searchableContent` filter which matches title +
// description. The `first` limit caps result count.
const ISSUE_SEARCH_QUERY = `
  query IssueSearch($filter: IssueFilter!, $first: Int!) {
    issues(filter: $filter, first: $first, orderBy: updatedAt) {
      nodes {
        id
        identifier
        title
        url
        state { name }
        priority
        updatedAt
      }
    }
  }
`;

function clampTitle(title: string): string {
  const oneLine = String(title || "").replace(/\s+/g, " ").trim();
  if (!oneLine) return "Untitled issue";
  return oneLine.length <= 240 ? oneLine : `${oneLine.slice(0, 237)}...`;
}

function redactSecrets(text: string): string {
  return String(text || "")
    .replace(/lin_api_[A-Za-z0-9_-]+/g, "lin_api_[REDACTED]")
    .replace(/Authorization:\s*[^\s'"`]+/gi, "Authorization: [REDACTED]");
}

export interface LinearToolsOptions {
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

// Shared GraphQL caller. Centralizes env check, fetch error handling, and
// AbortSignal/HTTP/GraphQL error → AgentToolResult shaping so each tool's
// execute() can stay focused on its own variables + payload extraction.
function makeLinearCall({
  fetchImpl,
  env,
}: {
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
}) {
  return async function call(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<{ data: any } | { error: AnyResult }> {
    const apiKey = env.LINEAR_API_KEY;
    if (!apiKey) {
      return {
        error: errorResult(
          `LINEAR_API_KEY is not set in the bot environment; cannot ${label}. Tell the user to set the env var.`,
        ),
      };
    }
    const apiUrl = env.LINEAR_API_URL || DEFAULT_LINEAR_API_URL;
    try {
      const response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal,
      });
      const payload: any = await response.json().catch(() => ({}));
      if (!response.ok || (payload && Array.isArray(payload.errors) && payload.errors.length > 0)) {
        const reason =
          (payload?.errors || []).map((e: any) => e?.message).filter(Boolean).join("; ") ||
          `HTTP ${response.status}`;
        return {
          error: errorResult(`Linear ${label} failed: ${redactSecrets(reason)}`),
        };
      }
      return { data: payload?.data || {} };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return {
          error: errorResult(`Linear ${label} aborted before completion.`),
        };
      }
      return {
        error: errorResult(
          `Linear ${label} request error: ${redactSecrets(err?.message || String(err))}`,
        ),
      };
    }
  };
}

export function createLinearToolsFactory({
  fetchImpl = fetch,
  env = process.env,
}: LinearToolsOptions = {}) {
  const call = makeLinearCall({ fetchImpl, env });

  return function linearTools(pi: ExtensionAPI) {
    // ---- linear_search_issues ------------------------------------------
    pi.registerTool({
      name: "linear_search_issues",
      label: "Search Linear issues",
      description:
        "Search Linear for existing issues whose title or description matches a query string. Use this BEFORE linear_create_issue to avoid duplicates: if a relevant issue already exists, prefer adding a comment via linear_add_comment instead of creating a new one. Results include identifier, title, URL, state, and priority. Defaults to the configured team; results are ordered by most recently updated.",
      promptSnippet:
        "linear_search_issues: find existing Linear issues matching a query before creating a new one.",
      promptGuidelines: [
        "Call linear_search_issues first when the user asks to file/track something — duplicate prevention.",
        "Pass the most distinctive phrase or proper noun from the user's request as the query.",
        "If a result clearly matches, prefer linear_add_comment over linear_create_issue.",
        "Limit results to ≤5 unless the user explicitly asks for more.",
      ],
      parameters: Type.Object({
        query: Type.String({
          minLength: 1,
          maxLength: 500,
          description:
            "Substring to match against issue titles and descriptions (case-insensitive).",
        }),
        limit: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: 25,
            description: "Maximum number of issues to return. Default 5.",
          }),
        ),
        team_only: Type.Optional(
          Type.Boolean({
            description:
              "If true (default), restrict to the configured LINEAR_TEAM_ID. Set false to search across all teams the API key has access to.",
          }),
        ),
      }),
      async execute(_toolCallId, params: any, signal) {
        const query = String(params.query || "").trim();
        const first = Math.max(1, Math.min(25, Number(params.limit) || 5));
        const teamOnly = params.team_only !== false; // default true
        const teamId = env.LINEAR_TEAM_ID;

        const filter: Record<string, unknown> = {
          searchableContent: { contains: query },
        };
        if (teamOnly && teamId) {
          filter.team = { id: { eq: teamId } };
        }

        const result = await call(ISSUE_SEARCH_QUERY, { filter, first }, signal, "issueSearch");
        if ("error" in result) return result.error;

        const nodes: any[] = result.data?.issues?.nodes || [];
        if (nodes.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No Linear issues matched "${query}"${teamOnly && teamId ? " in the configured team" : ""}. Safe to create a new issue if the user explicitly wants one.`,
              },
            ],
            details: { matches: [], query, teamOnly, teamId: teamOnly ? teamId : undefined },
          };
        }

        const lines = nodes.map((issue, i) =>
          `${i + 1}. ${issue.identifier} — ${issue.title}${issue.state?.name ? ` [${issue.state.name}]` : ""}\n   ${issue.url}`,
        );
        return {
          content: [
            {
              type: "text",
              text: `Found ${nodes.length} Linear issue${nodes.length === 1 ? "" : "s"} matching "${query}":\n\n${lines.join("\n\n")}`,
            },
          ],
          details: {
            matches: nodes.map((n) => ({
              id: n.id,
              identifier: n.identifier,
              title: n.title,
              url: n.url,
              state: n.state?.name,
              priority: n.priority,
              updatedAt: n.updatedAt,
            })),
            query,
            teamOnly,
            teamId: teamOnly ? teamId : undefined,
          },
        };
      },
    });

    // ---- linear_create_issue ---------------------------------------------
    pi.registerTool({
      name: "linear_create_issue",
      label: "Create Linear issue",
      description:
        "Create a new Linear issue under the configured team/project. Returns the Linear issue URL and identifier. Use this when the user explicitly asks to create/file/open a Linear issue or ticket AND you have already called linear_search_issues to confirm no relevant existing issue exists. Do NOT call this tool more than once in a turn. Optional team_id and project_id parameters override the env defaults (LINEAR_TEAM_ID, LINEAR_PROJECT_ID) for a single call when the user or a structured intake supplies a specific Linear UUID.",
      promptSnippet:
        "linear_create_issue: create a new Linear issue with a concise title and a Markdown description.",
      promptGuidelines: [
        "Call linear_search_issues first to check for existing matches; only call linear_create_issue if no match is appropriate.",
        "Call linear_create_issue at most once per turn; never twice for the same Slack thread.",
        "Title must be a single concise line (≤240 chars). Description is full Markdown.",
        "Include problem, context, proposed solution/spec, acceptance criteria, priority/severity suggestion in the description.",
        "After the tool returns, include the issue identifier and URL in your final reply to the user.",
        "Optional team_id and project_id override the bot's default Linear team/project for this single issue. Pass them only when the user (or a structured intake proposal) provides a specific Linear UUID; otherwise omit so the env defaults apply.",
      ],
      parameters: Type.Object({
        title: Type.String({
          minLength: 1,
          maxLength: 500,
          description: "Concise issue title (single line; will be clamped to 240 chars).",
        }),
        description: Type.String({
          minLength: 1,
          description:
            "Issue description in Markdown. Include problem, context, proposed solution, acceptance criteria, and source Slack thread reference if known.",
        }),
        priority: Type.Optional(
          Type.Number({
            minimum: 0,
            maximum: 4,
            description: "Linear priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low. Defaults to unset (no priority).",
          }),
        ),
        team_id: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 64,
            description:
              "Override LINEAR_TEAM_ID for this call. If omitted, falls back to env.LINEAR_TEAM_ID.",
          }),
        ),
        project_id: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 64,
            description:
              "Override LINEAR_PROJECT_ID for this call. If omitted, falls back to env.LINEAR_PROJECT_ID.",
          }),
        ),
      }),
      async execute(_toolCallId, params: any, signal) {
        const effectiveTeamId = (typeof params.team_id === "string" && params.team_id.trim()) ? params.team_id.trim() : env.LINEAR_TEAM_ID;
        const effectiveProjectId = (typeof params.project_id === "string" && params.project_id.trim()) ? params.project_id.trim() : env.LINEAR_PROJECT_ID;
        if (!effectiveTeamId) {
          return errorResult(
            "LINEAR_TEAM_ID is not set in the bot environment; cannot create a Linear issue without a team.",
          );
        }
        const stateId = env.LINEAR_STATE_ID;
        const title = clampTitle(params.title);
        const description = String(params.description || "").trim();
        const priority = typeof params.priority === "number" ? params.priority : undefined;

        const input: Record<string, unknown> = { teamId: effectiveTeamId, title, description };
        if (effectiveProjectId) input.projectId = effectiveProjectId;
        if (stateId) input.stateId = stateId;
        if (priority !== undefined) input.priority = priority;

        const result = await call(ISSUE_CREATE_MUTATION, { input }, signal, "issueCreate");
        if ("error" in result) return result.error;

        const created = result.data?.issueCreate;
        if (!created?.success || !created?.issue) {
          return errorResult(
            "Linear issueCreate returned success=false without an issue payload. No issue was created.",
          );
        }
        const issue = created.issue;
        return {
          content: [
            {
              type: "text",
              text: `Created Linear issue ${issue.identifier}: ${issue.title}\nURL: ${issue.url}`,
            },
          ],
          details: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
          },
        };
      },
    });

    // ---- linear_add_comment ----------------------------------------------
    pi.registerTool({
      name: "linear_add_comment",
      label: "Add comment to Linear issue",
      description:
        "Add a Markdown comment to an existing Linear issue. Use this AFTER linear_search_issues finds a relevant match, instead of creating a duplicate. Returns the comment URL. Pass either the issue's GraphQL ID (preferred, returned by linear_search_issues as `id`) or the human-readable identifier (e.g. 'FE-554').",
      promptSnippet:
        "linear_add_comment: add a Markdown comment to an existing Linear issue.",
      promptGuidelines: [
        "Prefer this over linear_create_issue when a related issue already exists.",
        "Reference the source Slack thread or context in the comment body for traceability.",
        "One comment per turn; if you have multiple separate points to make, combine them with bullet points.",
        "After the tool returns, include the comment URL in your final reply.",
      ],
      parameters: Type.Object({
        issue_id: Type.String({
          minLength: 1,
          description:
            "Linear issue identifier. Accepts either the GraphQL UUID (preferred — get this from linear_search_issues `id`) or the human identifier like 'FE-554'.",
        }),
        body: Type.String({
          minLength: 1,
          description:
            "Comment body in Markdown. Include source context (Slack thread reference, user, decision rationale) so future readers understand the trigger.",
        }),
      }),
      async execute(_toolCallId, params: any, signal) {
        const rawId = String(params.issue_id || "").trim();
        const body = String(params.body || "").trim();
        if (!rawId) {
          return errorResult("issue_id is required.");
        }
        if (!body) {
          return errorResult("body is required.");
        }

        // If the caller passed a human identifier (FE-554 style), resolve it
        // to a GraphQL ID first via a single-shot lookup.
        let issueId = rawId;
        if (!/^[0-9a-fA-F-]{36}$/.test(rawId)) {
          const lookup = await call(
            `query IssueLookup($id: String!) { issue(id: $id) { id identifier } }`,
            { id: rawId },
            signal,
            "issueLookup",
          );
          if ("error" in lookup) return lookup.error;
          const found = lookup.data?.issue;
          if (!found?.id) {
            return errorResult(
              `Linear issue "${rawId}" not found. Pass either the GraphQL UUID (from linear_search_issues) or a valid human identifier like FE-554.`,
            );
          }
          issueId = found.id;
        }

        const result = await call(
          COMMENT_CREATE_MUTATION,
          { input: { issueId, body } },
          signal,
          "commentCreate",
        );
        if ("error" in result) return result.error;
        const created = result.data?.commentCreate;
        if (!created?.success || !created?.comment) {
          return errorResult(
            "Linear commentCreate returned success=false without a comment payload. No comment was added.",
          );
        }
        const comment = created.comment;
        return {
          content: [
            {
              type: "text",
              text: `Added comment to ${rawId}.\nURL: ${comment.url}`,
            },
          ],
          details: { id: comment.id, url: comment.url, issueId, body: comment.body },
        };
      },
    });
  };
}

// Default export uses real fetch + process.env so pi-sdk-runner can pass the
// factory straight into DefaultResourceLoader.extensionFactories without
// configuration.
export default createLinearToolsFactory();
