// Pi custom tool: linear_create_issue.
//
// Replaces the legacy post-stream GraphQL call wired into apps/pi-mom/index.mjs
// (createLinearIssueFromPiOutputUnlessDuplicate). The model now invokes this
// tool directly via the Pi SDK's tool-call surface, which gives us:
//   - Idempotency that lives in the model's reasoning ("don't create if one
//     already exists in this thread") instead of a thread-scan side effect.
//   - Composability: in later passes we add linear_search/comment/update and
//     the model can chain them in a single turn.
//   - Per-route gating via control-plane/registry.yaml `tools:` lists.
//
// Scope: MVP — single tool. Search/comment/update land in follow-up stages.
//
// Env contract:
//   LINEAR_API_KEY     required (Bearer-style header)
//   LINEAR_TEAM_ID     required (Linear team UUID)
//   LINEAR_PROJECT_ID  optional (default project for created issues)
//   LINEAR_STATE_ID    optional (initial workflow state)
//   LINEAR_API_URL     optional override (default https://api.linear.app/graphql)
//
// Error model:
//   - Missing env → return AgentToolResult with isError=true. Model receives
//     a human-readable explanation and can decide how to recover.
//   - HTTP / GraphQL failures → isError=true, redacted error in content.
//   - AbortSignal → isError=true, "Linear request aborted".

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

// Factory that closes over a fetch impl + env snapshot — exposed so tests can
// inject a fake fetch and env without touching globals.
export function createLinearToolsFactory({
  fetchImpl = fetch,
  env = process.env,
}: LinearToolsOptions = {}) {
  return function linearTools(pi: ExtensionAPI) {
    pi.registerTool({
      name: "linear_create_issue",
      label: "Create Linear issue",
      description:
        "Create a new Linear issue under the configured team/project. Returns the Linear issue URL and identifier. Use this when the user explicitly asks to create/file/open a Linear issue or ticket. Do NOT call this tool more than once in a turn; if a prior issue may already exist for the current Slack thread, prefer to mention the existing identifier instead of creating a duplicate.",
      promptSnippet:
        "linear_create_issue: create a new Linear issue with a concise title and a Markdown description.",
      promptGuidelines: [
        "Call linear_create_issue at most once per turn; never twice for the same Slack thread.",
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
      }),
      async execute(_toolCallId, params: any, signal) {
        const apiKey = env.LINEAR_API_KEY;
        const teamId = env.LINEAR_TEAM_ID;
        const projectId = env.LINEAR_PROJECT_ID;
        const stateId = env.LINEAR_STATE_ID;
        const apiUrl = env.LINEAR_API_URL || DEFAULT_LINEAR_API_URL;

        if (!apiKey) {
          return {
            content: [
              {
                type: "text",
                text: "LINEAR_API_KEY is not set in the bot environment; cannot create a Linear issue. Tell the user to set the env var.",
              },
            ],
            isError: true,
          };
        }
        if (!teamId) {
          return {
            content: [
              {
                type: "text",
                text: "LINEAR_TEAM_ID is not set in the bot environment; cannot create a Linear issue without a team.",
              },
            ],
            isError: true,
          };
        }

        const title = clampTitle(params.title);
        const description = String(params.description || "").trim();
        const priority = typeof params.priority === "number" ? params.priority : undefined;

        const input: Record<string, unknown> = { teamId, title, description };
        if (projectId) input.projectId = projectId;
        if (stateId) input.stateId = stateId;
        if (priority !== undefined) input.priority = priority;

        try {
          const response = await fetchImpl(apiUrl, {
            method: "POST",
            headers: {
              Authorization: apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: ISSUE_CREATE_MUTATION, variables: { input } }),
            signal,
          });
          const payload: any = await response.json().catch(() => ({}));

          if (!response.ok || (payload && Array.isArray(payload.errors) && payload.errors.length > 0)) {
            const reason =
              (payload?.errors || []).map((e: any) => e?.message).filter(Boolean).join("; ") ||
              `HTTP ${response.status}`;
            return {
              content: [{ type: "text", text: `Linear issueCreate failed: ${redactSecrets(reason)}` }],
              isError: true,
            };
          }

          const created = payload?.data?.issueCreate;
          if (!created?.success || !created?.issue) {
            return {
              content: [
                {
                  type: "text",
                  text: "Linear issueCreate returned success=false without an issue payload. No issue was created.",
                },
              ],
              isError: true,
            };
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
        } catch (err: any) {
          if (err?.name === "AbortError") {
            return {
              content: [{ type: "text", text: "Linear request aborted before completion." }],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Linear request error: ${redactSecrets(err?.message || String(err))}`,
              },
            ],
            isError: true,
          };
        }
      },
    });
  };
}

// Default export uses real fetch + process.env so pi-sdk-runner can pass the
// factory straight into DefaultResourceLoader.extensionFactories without
// configuration.
export default createLinearToolsFactory();
