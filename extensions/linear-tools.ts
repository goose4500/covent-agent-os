// Pi custom tools for Linear. Four tools, all model-invoked via the Pi SDK
// tool surface:
//
//   linear_list_teams     — discover the teams (with id/key/name) the API key
//                           has access to. The model calls this first when it
//                           is not sure which team an issue belongs to.
//                           Result is cached per process lifetime.
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
// Composability is the win: the model can chain list_teams → search →
// comment-or-create in a single turn, picking the correct team based on the
// user's intent (frontend bug → FE, backend bug → BE, idea → RND, historical
// data work → HIS) instead of being pinned to a single hard-coded team.
//
// Env contract:
//   LINEAR_API_KEY     required (Bearer-style header). Org-wide API keys can
//                      see every team the issuing user has access to.
//   LINEAR_TEAM_ID     optional default team for create + optional filter on
//                      search. Backwards-compat fallback when the model does
//                      not pass an explicit `team_id`.
//   LINEAR_PROJECT_ID  optional default project for created issues. Backwards-
//                      compat fallback when the model does not pass an
//                      explicit `project_id`.
//   LINEAR_STATE_ID    optional initial workflow state for created issues.
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

// Teams query. We cap at 50 (Linear's max page size for teams) — the org has
// 4 teams today; more than 50 is a workspace red flag, not a real case.
const TEAMS_QUERY = `
  query Teams {
    teams(first: 50) {
      nodes {
        id
        key
        name
        description
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

  // Per-process teams cache. The 4-team map is stable across a Slack session
  // (and basically forever) so we cache the first successful list_teams
  // response and serve subsequent calls from memory. Cache is cleared when
  // a tool call returns an error so a transient failure doesn't poison
  // future requests.
  let teamsCache: Array<{ id: string; key: string; name: string; description: string | null }> | null = null;

  return function linearTools(pi: ExtensionAPI) {
    // ---- linear_list_teams ----------------------------------------------
    // Discovery tool. The agent calls this first whenever it's unsure which
    // team a request belongs to (e.g., user says "file a backend bug" — the
    // agent looks up which team has key "BE" and passes its `id` to
    // linear_create_issue).
    pi.registerTool({
      name: "linear_list_teams",
      label: "List Linear teams",
      description:
        "List all Linear teams the API key has access to, returning each team's GraphQL `id`, human `key` (e.g. FE, BE, RND, HIS), `name`, and `description`. Call this BEFORE linear_create_issue or linear_search_issues whenever you are not certain which team the user wants. Results are cached for the rest of this session, so repeat calls are cheap. Common Covent teams: FE = Frontend Engineering (UI/UX bugs, frontend features), BE = Backend Engineering (API/server/data-pipeline bugs, backend features), RND = Research and Development (ideas, experiments, exploratory work), HIS = Historical Data (data backfill, ETL, historical fixes).",
      promptSnippet:
        "linear_list_teams: discover which Linear teams exist so you can pick the right one before creating or searching issues.",
      promptGuidelines: [
        "Call this first if the user's request mentions a different surface (frontend, backend, data, research, etc.) than the configured default team.",
        "Use the returned `id` value as the `team_id` argument to linear_create_issue / linear_search_issues.",
        "Map intent to team key: frontend/UI → FE, backend/API/data pipeline → BE, ideas/exploration/RND → RND, historical-data/backfill → HIS.",
        "If the user explicitly names a team (\"file this in BE\", \"create in Frontend\"), still call this once per session to resolve the key to a UUID — do not hardcode IDs.",
      ],
      parameters: Type.Object({}),
      async execute(_toolCallId, _params: any, signal) {
        if (teamsCache) {
          const lines = teamsCache.map(
            (t, i) => `${i + 1}. ${t.key} — ${t.name}\n   id: ${t.id}${t.description ? `\n   ${t.description}` : ""}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `Linear teams (${teamsCache.length}, cached):\n\n${lines.join("\n\n")}`,
              },
            ],
            details: { teams: teamsCache, cached: true },
          };
        }

        const result = await call(TEAMS_QUERY, {}, signal, "teamsList");
        if ("error" in result) return result.error;

        const nodes: any[] = result.data?.teams?.nodes || [];
        teamsCache = nodes.map((t) => ({
          id: t.id,
          key: t.key,
          name: t.name,
          description: t.description ?? null,
        }));

        if (teamsCache.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No Linear teams visible to this API key. Tell the user the LINEAR_API_KEY may be scoped to a single team or revoked.",
              },
            ],
            details: { teams: [], cached: false },
          };
        }

        const lines = teamsCache.map(
          (t, i) => `${i + 1}. ${t.key} — ${t.name}\n   id: ${t.id}${t.description ? `\n   ${t.description}` : ""}`,
        );
        return {
          content: [
            {
              type: "text",
              text: `Linear teams (${teamsCache.length}):\n\n${lines.join("\n\n")}`,
            },
          ],
          details: { teams: teamsCache, cached: false },
        };
      },
    });

    // ---- linear_search_issues ------------------------------------------
    pi.registerTool({
      name: "linear_search_issues",
      label: "Search Linear issues",
      description:
        "Search Linear for existing issues whose title or description matches a query string. Use this BEFORE linear_create_issue to avoid duplicates: if a relevant issue already exists, prefer adding a comment via linear_add_comment instead of creating a new one. Results include identifier, title, URL, state, and priority. Pass `team_id` to scope to a specific team (use linear_list_teams to discover IDs); omit it to use the default LINEAR_TEAM_ID env var; or set `team_only=false` to search across every team the API key can see. Results are ordered by most recently updated.",
      promptSnippet:
        "linear_search_issues: find existing Linear issues matching a query before creating a new one.",
      promptGuidelines: [
        "Call linear_search_issues first when the user asks to file/track something — duplicate prevention.",
        "Pass the most distinctive phrase or proper noun from the user's request as the query.",
        "If a result clearly matches, prefer linear_add_comment over linear_create_issue.",
        "Limit results to ≤5 unless the user explicitly asks for more.",
        "When the user's intent points to a non-default team (frontend/backend/data/research), pass the matching `team_id` from linear_list_teams. Use `team_only=false` only when explicitly searching every team.",
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
        team_id: Type.Optional(
          Type.String({
            description:
              "Linear team UUID to scope the search to. Get this from linear_list_teams. If omitted, falls back to LINEAR_TEAM_ID env var.",
          }),
        ),
        team_only: Type.Optional(
          Type.Boolean({
            description:
              "If true (default), restrict to the resolved team_id. Set false to search across all teams the API key has access to (ignores team_id).",
          }),
        ),
      }),
      async execute(_toolCallId, params: any, signal) {
        const query = String(params.query || "").trim();
        const first = Math.max(1, Math.min(25, Number(params.limit) || 5));
        const teamOnly = params.team_only !== false; // default true
        const explicitTeamId = typeof params.team_id === "string" && params.team_id.trim()
          ? params.team_id.trim()
          : undefined;
        const teamId = explicitTeamId || env.LINEAR_TEAM_ID;

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
        "Create a new Linear issue. Pick the team based on the user's intent: frontend bugs/UI/UX → FE, backend bugs/API/data pipeline → BE, ideas/exploration → RND, historical-data/backfill → HIS. Pass the team UUID via `team_id` (get it from linear_list_teams); if omitted, falls back to LINEAR_TEAM_ID env var. Optionally pass `project_id` to file under a specific project; otherwise falls back to LINEAR_PROJECT_ID env var. Returns the Linear issue URL and identifier. Use this when the user explicitly asks to create/file/open a Linear issue or ticket AND you have already called linear_search_issues to confirm no relevant existing issue exists. Do NOT call this tool more than once in a turn.",
      promptSnippet:
        "linear_create_issue: create a new Linear issue with a concise title, a Markdown description, and the right team_id for the user's intent.",
      promptGuidelines: [
        "Call linear_list_teams first whenever the request mentions a non-default surface (frontend/backend/data/research) so you have the correct team UUID.",
        "Call linear_search_issues with the matching team_id BEFORE create to check for duplicates.",
        "Call linear_create_issue at most once per turn; never twice for the same Slack thread.",
        "Pick team_id by intent: FE for frontend, BE for backend, RND for ideas/research, HIS for historical-data work. Only omit team_id when the user clearly wants the default team.",
        "Title must be a single concise line (≤240 chars). Description is full Markdown.",
        "Include problem, context, proposed solution/spec, acceptance criteria, priority/severity suggestion in the description.",
        "After the tool returns, include the issue identifier and URL in your final reply to the user.",
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
            description:
              "Linear team UUID to file under. Get this from linear_list_teams. If omitted, falls back to LINEAR_TEAM_ID env var (the default team).",
          }),
        ),
        project_id: Type.Optional(
          Type.String({
            description:
              "Optional Linear project UUID. If omitted, falls back to LINEAR_PROJECT_ID env var. Pass an empty string to explicitly file with no project.",
          }),
        ),
      }),
      async execute(_toolCallId, params: any, signal) {
        const explicitTeamId = typeof params.team_id === "string" && params.team_id.trim()
          ? params.team_id.trim()
          : undefined;
        const teamId = explicitTeamId || env.LINEAR_TEAM_ID;
        if (!teamId) {
          return errorResult(
            "No team_id passed and LINEAR_TEAM_ID is not set in the bot environment. Call linear_list_teams to find a team UUID, then pass it as `team_id`.",
          );
        }
        // Project: explicit empty-string opts out, undefined falls back to env,
        // any other string uses that ID.
        let projectId: string | undefined;
        if (typeof params.project_id === "string") {
          projectId = params.project_id.trim() || undefined;
        } else {
          projectId = env.LINEAR_PROJECT_ID || undefined;
        }
        // Only respect the env-configured state if the chosen team matches the
        // env-configured team — workflow state IDs are team-scoped, so a state
        // belonging to FE will be rejected by Linear if we apply it to a BE
        // create. When the model targets a non-default team we let Linear pick
        // the team's default initial state.
        const stateId = teamId === env.LINEAR_TEAM_ID ? env.LINEAR_STATE_ID : undefined;
        const title = clampTitle(params.title);
        const description = String(params.description || "").trim();
        const priority = typeof params.priority === "number" ? params.priority : undefined;

        const input: Record<string, unknown> = { teamId, title, description };
        if (projectId) input.projectId = projectId;
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
            teamId,
            projectId: projectId || null,
          },
        };
      },
    });

    // ---- linear_add_comment ----------------------------------------------
    pi.registerTool({
      name: "linear_add_comment",
      label: "Add comment to Linear issue",
      description:
        "Add a Markdown comment to an existing Linear issue. Use this AFTER linear_search_issues finds a relevant match, instead of creating a duplicate. Returns the comment URL. Pass either the issue's GraphQL ID (preferred, returned by linear_search_issues as `id`) or the human-readable identifier (e.g. 'FE-554', 'BE-12', 'RND-7'). Comments work across all teams the API key can see; no team_id needed.",
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
            "Linear issue identifier. Accepts either the GraphQL UUID (preferred — get this from linear_search_issues `id`) or the human identifier like 'FE-554' / 'BE-12' / 'RND-7'.",
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
