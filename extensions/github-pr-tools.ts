// Pi custom tools for the GitHub PR lifecycle. Four tools registered as
// top-level Pi tools so the model can drive PR work without going through
// the `mcp({ server: "github", tool: "…" })` proxy:
//
//   github_get_pr       — read PR metadata (title, body, head/base, state,
//                         mergeable, draft, html_url). No approval gate;
//                         read-only.
//   github_pr_comment   — post an issue-style comment on a PR (or any
//                         issue, since GitHub treats them the same). No
//                         approval gate: comments are reversible and
//                         low-blast-radius.
//   github_create_pr    — create a PR. ALWAYS gated by an in-thread Slack
//                         approval card showing title/body/head/base; no
//                         Slack UI → tool errors out (matches ADR 0010's
//                         "explicit Slack user approval" boundary).
//   github_merge_pr     — merge a PR. ALWAYS gated. Approval card shows
//                         PR identifier, merge_method, and commit
//                         title/message that will be used. Resolves the
//                         ADR 0010 follow-up #2.
//
// Why a wrapper extension instead of `directTools: true` on the GitHub MCP:
//   - Stable tool names. `github_create_pr` is a bridge contract; the
//     upstream MCP can rename / reshape `create_pull_request` without
//     breaking our prompts.
//   - Forced approval UX. The mutating tools own the approval card so the
//     human sees a structured preview every time, regardless of whether
//     the model remembered to ask.
//   - Telemetry hooks. All four tools return both a text summary (for the
//     model) and a structured `details` payload (for sinks / future
//     observability).
//   - Smaller token footprint than enabling every GitHub MCP tool as a
//     direct top-level tool — we expose four named tools, not the full
//     toolset surface.
//
// Env contract:
//   GITHUB_MCP_PAT     required. Same fine-grained PAT the GitHub MCP
//                      server uses (see ADR 0010 for the permission
//                      table). Bearer-style header.
//   GITHUB_OWNER       optional (default "goose4500"). Mirrors the MCP
//                      scope so accidental cross-repo writes are unlikely.
//   GITHUB_REPO        optional (default "covent-agent-os").
//   GITHUB_API_URL     optional (default "https://api.github.com"). Set
//                      for GitHub Enterprise.
//
// Error model (all tools):
//   - Missing token / params → AgentToolResult { isError: true } with a
//     clear text reason.
//   - Approval rejected / timed out (mutating tools) → isError with the
//     decision string in the text.
//   - HTTP failure → isError with status + redacted body.
//   - AbortSignal → isError, "GitHub … aborted".

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const DEFAULT_OWNER = "goose4500";
const DEFAULT_REPO = "covent-agent-os";

type AnyResult = {
  content: Array<{ type: "text"; text: string }>;
  details: any;
  isError?: boolean;
};

function errorResult(text: string): AnyResult {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

function textResult(text: string, details?: any): AnyResult {
  return { content: [{ type: "text", text }], details };
}

// Same redaction surface as linear-tools: any leaked PAT-shaped string in
// an error message is masked before it reaches the model or Slack.
function redactSecrets(text: string): string {
  return String(text || "")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "gh*_[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[REDACTED]")
    .replace(/Authorization:\s*[^\s'"`]+/gi, "Authorization: [REDACTED]");
}

type SlackUI = {
  confirmWithPreview?: (
    title: string,
    summary: string,
    previewMd: string,
    opts?: { approveLabel?: string; rejectLabel?: string; signal?: AbortSignal; timeout?: number },
  ) => Promise<boolean>;
};

function getSlackUI(ctx: ExtensionContext | undefined): SlackUI | undefined {
  return (ctx?.ui as unknown as SlackUI | undefined) ?? undefined;
}

const NOT_SLACK_BOUND_HINT =
  "Tell the user this action requires a Slack thread for approval; ask them to re-run from Slack.";

export interface GitHubPrToolsOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

function makeGitHubCall({
  fetchImpl,
  env,
}: {
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
}) {
  return async function call(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<{ data: any; status: number } | { error: AnyResult }> {
    const token = env.GITHUB_MCP_PAT;
    if (!token) {
      return {
        error: errorResult(
          `GITHUB_MCP_PAT is not set in the bot environment; cannot ${label}. Tell the user to set the env var (see ADR 0010 for the required scopes).`,
        ),
      };
    }
    const apiUrl = (env.GITHUB_API_URL || DEFAULT_GITHUB_API_URL).replace(/\/$/, "");
    const url = `${apiUrl}${path}`;
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "covent-pi-mom-github-pr-tools/1",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      const text = await response.text();
      let payload: any = {};
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
      }
      if (!response.ok) {
        const reason = payload?.message || `HTTP ${response.status}`;
        return {
          error: errorResult(
            `GitHub ${label} failed (${response.status}): ${redactSecrets(String(reason))}`,
          ),
        };
      }
      return { data: payload, status: response.status };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return { error: errorResult(`GitHub ${label} aborted before completion.`) };
      }
      return {
        error: errorResult(
          `GitHub ${label} request error: ${redactSecrets(err?.message || String(err))}`,
        ),
      };
    }
  };
}

function resolveTarget(
  params: { owner?: string; repo?: string },
  env: Record<string, string | undefined>,
): { owner: string; repo: string } {
  return {
    owner: (params.owner || env.GITHUB_OWNER || DEFAULT_OWNER).trim(),
    repo: (params.repo || env.GITHUB_REPO || DEFAULT_REPO).trim(),
  };
}

function clampPreview(text: string, max = 2800): string {
  const s = String(text || "");
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

export function createGitHubPrToolsFactory({
  fetchImpl = fetch,
  env = process.env as Record<string, string | undefined>,
}: GitHubPrToolsOptions = {}) {
  const call = makeGitHubCall({ fetchImpl, env });

  return function githubPrTools(pi: ExtensionAPI) {
    // ---- github_get_pr -----------------------------------------------------
    pi.registerTool({
      name: "github_get_pr",
      label: "Get GitHub PR",
      description:
        "Fetch metadata for a GitHub pull request: title, body, head/base branches, state (open/closed/merged), draft flag, mergeable status, and html_url. Use this BEFORE github_merge_pr to confirm you are merging the right PR, or before a comment to read the current title/body. Read-only; no approval needed. Defaults to goose4500/covent-agent-os; pass `owner` / `repo` only when targeting another repo this token can see.",
      promptSnippet:
        "github_get_pr: read PR metadata before commenting, merging, or replying about it.",
      promptGuidelines: [
        "Call this BEFORE github_merge_pr so the approval card and your reply both reference the right PR.",
        "Use it to confirm head/base branches before opening a follow-up PR against the same target.",
        "Cheap to call; do not skip it just because the user mentioned a PR number — verify state first.",
      ],
      parameters: Type.Object({
        pull_number: Type.Number({
          minimum: 1,
          description: "PR number (e.g. 122 for goose4500/covent-agent-os#122).",
        }),
        owner: Type.Optional(Type.String({
          description: "Repo owner. Defaults to GITHUB_OWNER env or 'goose4500'.",
        })),
        repo: Type.Optional(Type.String({
          description: "Repo name. Defaults to GITHUB_REPO env or 'covent-agent-os'.",
        })),
      }),
      async execute(_toolCallId, params: any, signal) {
        const { owner, repo } = resolveTarget(params, env);
        const result = await call(
          "GET",
          `/repos/${owner}/${repo}/pulls/${Number(params.pull_number)}`,
          undefined,
          signal,
          "PR get",
        );
        if ("error" in result) return result.error;
        const pr = result.data || {};
        const summary = [
          `${owner}/${repo}#${pr.number} — ${pr.title}`,
          `state: ${pr.state}${pr.merged ? " (merged)" : ""}${pr.draft ? " [draft]" : ""}`,
          `head: ${pr.head?.label || pr.head?.ref} → base: ${pr.base?.label || pr.base?.ref}`,
          `mergeable: ${pr.mergeable === null ? "unknown" : pr.mergeable}; mergeable_state: ${pr.mergeable_state ?? "unknown"}`,
          `url: ${pr.html_url}`,
        ].join("\n");
        return textResult(summary, {
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          merged: !!pr.merged,
          draft: !!pr.draft,
          mergeable: pr.mergeable,
          mergeable_state: pr.mergeable_state,
          head: { ref: pr.head?.ref, sha: pr.head?.sha, label: pr.head?.label },
          base: { ref: pr.base?.ref, sha: pr.base?.sha, label: pr.base?.label },
          html_url: pr.html_url,
          owner,
          repo,
        });
      },
    });

    // ---- github_pr_comment -------------------------------------------------
    // Comments use the issues endpoint because GitHub treats issue + PR
    // bodies/comments uniformly (PR review comments tied to a diff line use a
    // different endpoint and would deserve their own tool — out of scope for
    // this Stage-1 extension).
    pi.registerTool({
      name: "github_pr_comment",
      label: "Comment on GitHub PR/issue",
      description:
        "Post a Markdown comment on a GitHub pull request or issue. Reversible and low-blast-radius, so no approval card is shown — call it directly. Use this for PR review feedback, status updates, or replying to a question on an issue. Defaults to goose4500/covent-agent-os.",
      promptSnippet:
        "github_pr_comment: add a Markdown comment to a PR or issue.",
      promptGuidelines: [
        "Do NOT use this tool for the same comment twice in one turn.",
        "Reference the originating Slack thread or context in the comment body when relevant for traceability.",
        "After the tool returns, include the comment URL in your final reply.",
      ],
      parameters: Type.Object({
        issue_number: Type.Number({
          minimum: 1,
          description: "PR or issue number (PRs and issues share the same numbering namespace on GitHub).",
        }),
        body: Type.String({
          minLength: 1,
          description: "Comment body in Markdown.",
        }),
        owner: Type.Optional(Type.String({
          description: "Repo owner. Defaults to GITHUB_OWNER env or 'goose4500'.",
        })),
        repo: Type.Optional(Type.String({
          description: "Repo name. Defaults to GITHUB_REPO env or 'covent-agent-os'.",
        })),
      }),
      async execute(_toolCallId, params: any, signal) {
        const { owner, repo } = resolveTarget(params, env);
        const body = String(params.body || "").trim();
        if (!body) return errorResult("body is required.");
        const result = await call(
          "POST",
          `/repos/${owner}/${repo}/issues/${Number(params.issue_number)}/comments`,
          { body },
          signal,
          "comment create",
        );
        if ("error" in result) return result.error;
        const comment = result.data || {};
        return textResult(
          `Commented on ${owner}/${repo}#${params.issue_number}.\nURL: ${comment.html_url}`,
          { id: comment.id, html_url: comment.html_url, owner, repo, issue_number: params.issue_number },
        );
      },
    });

    // ---- github_create_pr --------------------------------------------------
    pi.registerTool({
      name: "github_create_pr",
      label: "Create GitHub PR",
      description:
        "Create a pull request in a GitHub repo. ALWAYS prompts the user for explicit approval via a Slack approval card showing the title, body, head, and base before sending the create request — per ADR 0010 PR create requires explicit Slack user approval. Returns the new PR's number and html_url on success. If the user rejects or the card times out, the tool returns isError without calling GitHub. Defaults to goose4500/covent-agent-os.",
      promptSnippet:
        "github_create_pr: open a PR after the user has explicitly asked you to. The tool itself shows a final approval card.",
      promptGuidelines: [
        "Only call this when the user has explicitly asked you to open a PR (or confirmed a previous suggestion to do so).",
        "Push the branch FIRST. The PR can only point at a head ref that exists on the remote.",
        "Title MUST be ≤70 chars and reflect the change. Body MUST include a Summary and Test plan section.",
        "Use draft=true for in-progress branches you want CI on but not yet ready for review.",
        "After the tool returns, include the PR URL in your final reply.",
      ],
      parameters: Type.Object({
        title: Type.String({
          minLength: 1,
          maxLength: 250,
          description: "PR title. Keep ≤70 chars; the rest belongs in the body.",
        }),
        body: Type.String({
          minLength: 1,
          description: "PR description in Markdown. Include Summary + Test plan sections at minimum.",
        }),
        head: Type.String({
          minLength: 1,
          description: "Branch containing the changes (e.g. 'claude/implement-issue-121-yCDei'). Must exist on the remote.",
        }),
        base: Type.Optional(Type.String({
          description: "Base branch to merge into. Defaults to 'main'.",
        })),
        draft: Type.Optional(Type.Boolean({
          description: "Open as draft PR. Default false.",
        })),
        owner: Type.Optional(Type.String({
          description: "Repo owner. Defaults to GITHUB_OWNER env or 'goose4500'.",
        })),
        repo: Type.Optional(Type.String({
          description: "Repo name. Defaults to GITHUB_REPO env or 'covent-agent-os'.",
        })),
      }),
      async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
        const ui = getSlackUI(ctx);
        if (!ui?.confirmWithPreview) {
          return errorResult(`github_create_pr requires a Slack-bound Pi turn for approval. ${NOT_SLACK_BOUND_HINT}`);
        }
        const { owner, repo } = resolveTarget(params, env);
        const base = (params.base || "main").trim();
        const head = String(params.head || "").trim();
        const draft = params.draft === true;
        const title = String(params.title || "").trim();
        const body = String(params.body || "").trim();
        if (!head) return errorResult("head branch is required.");
        if (!title) return errorResult("title is required.");
        if (!body) return errorResult("body is required.");

        const previewMd = [
          `**Repo:** ${owner}/${repo}`,
          `**Head → Base:** \`${head}\` → \`${base}\`${draft ? "  _(draft)_" : ""}`,
          ``,
          `**Title:** ${title}`,
          ``,
          `**Body:**`,
          ``,
          clampPreview(body, 2400),
        ].join("\n");

        const startedAt = Date.now();
        const timeoutMs = 600_000;
        let approved = false;
        try {
          approved = await ui.confirmWithPreview(
            `Open PR in ${owner}/${repo}?`,
            `${head} → ${base}${draft ? " (draft)" : ""}`,
            previewMd,
            { approveLabel: "Open PR", rejectLabel: "Cancel", signal, timeout: timeoutMs },
          );
        } catch (err: any) {
          return errorResult(`github_create_pr approval card failed: ${err?.message || String(err)}`);
        }
        if (!approved) {
          const decision = signal?.aborted || Date.now() - startedAt >= timeoutMs ? "timeout" : "rejected";
          return errorResult(`github_create_pr ${decision}: PR was not created. Tell the user the action was not approved.`);
        }

        const result = await call(
          "POST",
          `/repos/${owner}/${repo}/pulls`,
          { title, body, head, base, draft },
          signal,
          "PR create",
        );
        if ("error" in result) return result.error;
        const pr = result.data || {};
        return textResult(
          `Opened ${owner}/${repo}#${pr.number}: ${pr.title}\nURL: ${pr.html_url}`,
          {
            number: pr.number,
            title: pr.title,
            html_url: pr.html_url,
            head,
            base,
            draft,
            owner,
            repo,
          },
        );
      },
    });

    // ---- github_merge_pr ---------------------------------------------------
    pi.registerTool({
      name: "github_merge_pr",
      label: "Merge GitHub PR",
      description:
        "Merge a pull request. ALWAYS prompts the user for explicit approval via a Slack approval card showing the PR identifier, title, head→base@sha, merge_method, and the commit title/message that will be used. Per ADR 0010, PR merge requires explicit Slack user approval — there is no escape hatch. The merge call is pinned to the exact head SHA shown in the approval card, so any push that lands between approval and merge will fail the request (GitHub 409) instead of silently merging unreviewed commits. Returns the merge SHA on success. If the user rejects, the card times out, or the head moves, the tool returns isError without merging. Defaults to goose4500/covent-agent-os.",
      promptSnippet:
        "github_merge_pr: merge a PR after the user has explicitly asked you to. The tool itself shows a final approval card.",
      promptGuidelines: [
        "Only call this when the user has explicitly asked you to merge (or confirmed a previous proposal).",
        "Call github_get_pr FIRST to confirm the PR is open, mergeable, and has the expected title/head/base.",
        "Default merge_method is 'squash'. Use 'merge' only when the user explicitly wants merge commits, 'rebase' when the project requires linear history.",
        "If commit_title is omitted GitHub uses the PR title; pass commit_title explicitly only when the merged commit message should differ from the PR title.",
        "After the tool returns, include the merge SHA and PR URL in your final reply.",
      ],
      parameters: Type.Object({
        pull_number: Type.Number({
          minimum: 1,
          description: "PR number to merge.",
        }),
        merge_method: Type.Optional(Type.Union(
          [Type.Literal("squash"), Type.Literal("merge"), Type.Literal("rebase")],
          { description: "GitHub merge method. Default 'squash'." },
        )),
        commit_title: Type.Optional(Type.String({
          description: "Merged commit title override. If omitted GitHub uses the PR title.",
          maxLength: 250,
        })),
        commit_message: Type.Optional(Type.String({
          description: "Merged commit body override. If omitted GitHub uses the PR body (squash) or default (merge/rebase).",
        })),
        owner: Type.Optional(Type.String({
          description: "Repo owner. Defaults to GITHUB_OWNER env or 'goose4500'.",
        })),
        repo: Type.Optional(Type.String({
          description: "Repo name. Defaults to GITHUB_REPO env or 'covent-agent-os'.",
        })),
      }),
      async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
        const ui = getSlackUI(ctx);
        if (!ui?.confirmWithPreview) {
          return errorResult(`github_merge_pr requires a Slack-bound Pi turn for approval. ${NOT_SLACK_BOUND_HINT}`);
        }
        const { owner, repo } = resolveTarget(params, env);
        const pullNumber = Number(params.pull_number);
        const mergeMethod: "squash" | "merge" | "rebase" = params.merge_method || "squash";

        // Fetch the PR first so the approval card shows the actual title /
        // head / base / state / mergeable status — not just whatever the
        // model claims. This is a deliberate extra round-trip in exchange
        // for a trustworthy human approval surface.
        const prResult = await call(
          "GET",
          `/repos/${owner}/${repo}/pulls/${pullNumber}`,
          undefined,
          signal,
          "PR get",
        );
        if ("error" in prResult) return prResult.error;
        const pr = prResult.data || {};
        if (pr.merged) {
          return errorResult(`${owner}/${repo}#${pullNumber} is already merged. No action taken.`);
        }
        if (pr.state !== "open") {
          return errorResult(`${owner}/${repo}#${pullNumber} is ${pr.state}, not open. Cannot merge.`);
        }

        const commitTitle = String(params.commit_title || pr.title || "").trim();
        const commitMessage = String(params.commit_message || "").trim();
        // Pin the merge to the exact head SHA the human approved. GitHub
        // returns 409 if the head moves between approval and the PUT call,
        // so a push that lands after the approval card is rendered will
        // fail closed instead of silently merging unreviewed commits.
        const approvedHeadSha = typeof pr.head?.sha === "string" ? pr.head.sha : "";

        const previewLines = [
          `**Repo:** ${owner}/${repo}`,
          `**PR:** #${pr.number} — ${pr.title}`,
          `**Head → Base:** \`${pr.head?.ref}${approvedHeadSha ? `@${approvedHeadSha.slice(0, 7)}` : ""}\` → \`${pr.base?.ref}\``,
          `**Merge method:** ${mergeMethod}`,
          `**Mergeable:** ${pr.mergeable === null ? "unknown" : pr.mergeable} (state: ${pr.mergeable_state ?? "unknown"})`,
          ``,
          `**Commit title:** ${commitTitle}`,
        ];
        if (commitMessage) {
          previewLines.push(``, `**Commit message:**`, ``, clampPreview(commitMessage, 1800));
        }
        const previewMd = previewLines.join("\n");

        const startedAt = Date.now();
        const timeoutMs = 600_000;
        let approved = false;
        try {
          approved = await ui.confirmWithPreview(
            `Merge ${owner}/${repo}#${pullNumber}?`,
            `${mergeMethod} merge of ${pr.head?.ref} → ${pr.base?.ref}`,
            previewMd,
            { approveLabel: `Merge (${mergeMethod})`, rejectLabel: "Cancel", signal, timeout: timeoutMs },
          );
        } catch (err: any) {
          return errorResult(`github_merge_pr approval card failed: ${err?.message || String(err)}`);
        }
        if (!approved) {
          const decision = signal?.aborted || Date.now() - startedAt >= timeoutMs ? "timeout" : "rejected";
          return errorResult(`github_merge_pr ${decision}: PR ${owner}/${repo}#${pullNumber} was NOT merged. Tell the user the action was not approved.`);
        }

        const mergeBody: Record<string, unknown> = { merge_method: mergeMethod };
        if (commitTitle) mergeBody.commit_title = commitTitle;
        if (commitMessage) mergeBody.commit_message = commitMessage;
        if (approvedHeadSha) mergeBody.sha = approvedHeadSha;

        const mergeResult = await call(
          "PUT",
          `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
          mergeBody,
          signal,
          "PR merge",
        );
        if ("error" in mergeResult) {
          // 409 from GitHub's merge endpoint with a `sha` guard means the
          // head moved between the approval card and the merge call. Re-shape
          // the error so the model + human reply make the cause obvious.
          const errText = mergeResult.error?.content?.[0]?.text || "";
          if (approvedHeadSha && /\b409\b/.test(errText)) {
            return errorResult(
              `github_merge_pr aborted: head of ${owner}/${repo}#${pullNumber} moved after approval (approved \`${approvedHeadSha.slice(0, 7)}\`). The PR was NOT merged. Re-run github_get_pr to inspect the new head, then re-request approval if the new commits are still safe to merge.`,
            );
          }
          return mergeResult.error;
        }
        const merge = mergeResult.data || {};
        if (!merge.merged) {
          return errorResult(
            `GitHub PR merge returned merged=false: ${redactSecrets(String(merge.message || "no message"))}`,
          );
        }
        return textResult(
          `Merged ${owner}/${repo}#${pullNumber} (${mergeMethod}).\nSHA: ${merge.sha}\nPR URL: ${pr.html_url}`,
          {
            sha: merge.sha,
            merge_method: mergeMethod,
            pull_number: pullNumber,
            html_url: pr.html_url,
            owner,
            repo,
          },
        );
      },
    });
  };
}

// Default export uses real fetch + process.env so pi-sdk-runner can pass the
// factory straight into DefaultResourceLoader.extensionFactories without
// configuration.
export default createGitHubPrToolsFactory();
