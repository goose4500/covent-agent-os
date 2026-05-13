// Pi custom tools for model-driven Slack interactivity.
//
// Three tools the model can call mid-turn when it needs human judgment that
// is specific to the current task. Each tool is a thin wrapper around a
// matching richer method on the bridge's slack UI context
// (apps/pi-mom/lib/slack-ui-context.mjs):
//
//   slack_approval_card   — confirmWithPreview: header + summary + preview
//                           markdown + Approve/Cancel buttons. Returns
//                           "approved" | "rejected" | "timeout".
//   slack_choice_card     — selectWithContext: N options each with their own
//                           markdown context block + button. Returns the
//                           chosen option's opaque id, or "timeout".
//   slack_input_request   — inputRequest: launcher button → modal text input
//                           (required by Slack's views.open trigger_id
//                           lifetime). Returns the user text,
//                           "skipped" on cancel, or "timeout".
//
// All three pre-flight the ctx.ui surface and return an `isError` result if
// invoked outside a Slack-bound Pi turn (e.g. unit tests, echo mode). The
// underlying primitives reuse the existing pi_uictx_* Bolt handlers and
// pendingApprovals lifecycle — no new wiring in index.mjs needed.
//
// Architecture note: these tools are intentionally generic. They do not
// implement specific workflows (linear, codex sign-in, deploy). The model
// composes the interaction by supplying title/preview/options/prompt based
// on its current task. Fixed bridge workflows stay in the bridge.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

// Type-erased view of the bridge-provided ctx.ui that exposes the three
// richer methods this extension depends on. We use `any` because the SDK's
// ExtensionUIContext type is closed and these methods are bridge extensions.
type SlackUI = {
  confirmWithPreview?: (
    title: string,
    summary: string,
    previewMd: string,
    opts?: { approveLabel?: string; rejectLabel?: string; signal?: AbortSignal; timeout?: number },
  ) => Promise<boolean>;
  selectWithContext?: (
    title: string,
    summary: string | undefined,
    options: Array<{ id: string; label: string; context_md?: string }>,
    opts?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<string | undefined>;
  inputRequest?: (
    title: string,
    prompt: string,
    opts?: { placeholder?: string; multiline?: boolean; signal?: AbortSignal; timeout?: number },
  ) => Promise<string | undefined>;
};

function getSlackUI(ctx: ExtensionContext | undefined): SlackUI | undefined {
  const ui = ctx?.ui as unknown as SlackUI | undefined;
  if (!ui) return undefined;
  return ui;
}

const NOT_SLACK_BOUND_HINT =
  "Tell the user it requires being invoked from a Slack thread; ask them in plain text instead.";

export default function slackInteractiveTools(pi: ExtensionAPI) {
  // ---- slack_approval_card -------------------------------------------------
  pi.registerTool({
    name: "slack_approval_card",
    label: "Slack approval card",
    description:
      "Post a Slack Block Kit approval card in the current thread asking the user to approve or reject a proposed action. Use this when about to mutate state (create a Linear issue, run a destructive command, commit changes) and you want explicit human sign-off with a structured preview of what will happen. The card shows: title (header), summary (one-line context), preview_md (markdown body — diff, drafted issue, command, etc.), and two buttons. Result is the user's decision string.",
    promptSnippet:
      "slack_approval_card: pause and ask for human approval with a previewed preview before a mutation.",
    promptGuidelines: [
      "Call slack_approval_card before any irreversible or high-impact action when the user has not pre-approved it in the current turn.",
      "Put the proposed change in `preview_md` (full markdown). Keep `summary` to one line that explains why approval is being asked.",
      "Wait for the result. 'approved' → proceed with the action. 'rejected' or 'timeout' → stop and tell the user.",
      "Do not chain back-to-back approval cards for the same decision; one approval covers the whole next mutation.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description: "Header text. e.g. 'Create Linear issue?' or 'Run rm -rf?'",
        minLength: 1,
        maxLength: 150,
      }),
      summary: Type.String({
        description: "One-line context for why approval is being asked. Shown directly under the header.",
        maxLength: 280,
      }),
      preview_md: Type.String({
        description: "Markdown preview of what will happen if approved (drafted issue body, diff, command). Max ~2900 chars.",
        minLength: 1,
        maxLength: 2900,
      }),
      approve_label: Type.Optional(Type.String({
        description: "Approve button label. Default 'Approve'.",
        maxLength: 75,
      })),
      reject_label: Type.Optional(Type.String({
        description: "Reject button label. Default 'Cancel'.",
        maxLength: 75,
      })),
      timeout_ms: Type.Optional(Type.Number({
        description: "Max wait in ms before resolving to 'timeout'. Default 600000 (10m), capped at 1800000 (30m).",
        minimum: 1000,
        maximum: 1800000,
      })),
    }),
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const ui = getSlackUI(ctx);
      if (!ui?.confirmWithPreview) {
        return errorResult(`slack_approval_card requires a Slack-bound Pi turn. ${NOT_SLACK_BOUND_HINT}`);
      }
      try {
        const ok = await ui.confirmWithPreview(params.title, params.summary, params.preview_md, {
          approveLabel: params.approve_label,
          rejectLabel: params.reject_label,
          signal,
          timeout: params.timeout_ms,
        });
        // The slack-ui-context primitive resolves to `defaultValue` (false)
        // on signal/timeout/dispose. We can't reliably distinguish 'rejected'
        // from 'timeout' from the boolean alone, so we report 'rejected' when
        // false and let the timeout label only apply when there's a strong
        // signal it was a timeout (signal aborted).
        if (ok === true) return textResult("approved");
        if (signal?.aborted) return textResult("timeout");
        return textResult("rejected");
      } catch (err: any) {
        return errorResult(`slack_approval_card failed: ${err?.message || String(err)}`);
      }
    },
  });

  // ---- slack_choice_card --------------------------------------------------
  pi.registerTool({
    name: "slack_choice_card",
    label: "Slack choice card",
    description:
      "Post a Slack Block Kit choice card in the current thread asking the user to pick one of 2–5 options. Each option has an opaque `id` (returned as the tool result), a button `label`, and an optional `context_md` markdown block shown above the button for richer rendering. Use this when you have multiple candidate paths and need human disambiguation — e.g. several Linear issues that could match, several files that could be the target, several plausible interpretations.",
    promptSnippet:
      "slack_choice_card: ask the user to pick one of N options when the right path is ambiguous.",
    promptGuidelines: [
      "Use slack_choice_card when the agent has 2–5 candidate paths and the user is best placed to disambiguate.",
      "Give each option a stable, distinctive `id`; the model receives back that id verbatim.",
      "Put the human-readable context (issue title/state, file path/preview, etc.) in `context_md` so the user can decide without leaving Slack.",
      "Treat a 'timeout' result as 'the user did not pick' — do not silently pick option 1.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description: "Header text. e.g. 'Which Linear issue should I comment on?'",
        minLength: 1,
        maxLength: 150,
      }),
      summary: Type.Optional(Type.String({
        description: "Optional one-line context above the options.",
        maxLength: 280,
      })),
      options: Type.Array(
        Type.Object({
          id: Type.String({
            description: "Stable opaque identifier returned as the tool result when this option is chosen.",
            minLength: 1,
            maxLength: 64,
          }),
          label: Type.String({
            description: "Button text shown to the user.",
            minLength: 1,
            maxLength: 75,
          }),
          context_md: Type.Optional(Type.String({
            description: "Markdown context shown above this option's button (e.g. issue ID, title, state, last-updated).",
            maxLength: 600,
          })),
        }),
        { minItems: 2, maxItems: 5 },
      ),
      timeout_ms: Type.Optional(Type.Number({
        description: "Max wait in ms before resolving to 'timeout'. Default 600000 (10m), capped at 1800000 (30m).",
        minimum: 1000,
        maximum: 1800000,
      })),
    }),
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const ui = getSlackUI(ctx);
      if (!ui?.selectWithContext) {
        return errorResult(`slack_choice_card requires a Slack-bound Pi turn. ${NOT_SLACK_BOUND_HINT}`);
      }
      try {
        const id = await ui.selectWithContext(params.title, params.summary, params.options, {
          signal,
          timeout: params.timeout_ms,
        });
        if (typeof id === "string" && id.length > 0) return textResult(id);
        return textResult("timeout");
      } catch (err: any) {
        return errorResult(`slack_choice_card failed: ${err?.message || String(err)}`);
      }
    },
  });

  // ---- slack_input_request -----------------------------------------------
  pi.registerTool({
    name: "slack_input_request",
    label: "Slack input request",
    description:
      "Post a Slack message with a 'Provide input' launcher button. When the user clicks it, a modal opens with a text field. Use this when you need free-form text from the user mid-turn that you cannot infer from context — a Linear issue title, a missing parameter, an explanation. The user can also Skip. Returns the user's text, 'skipped' if they canceled, or 'timeout' if no response in time.",
    promptSnippet:
      "slack_input_request: ask the user for free-form text input via a Slack modal.",
    promptGuidelines: [
      "Use slack_input_request when you need text the user must provide and cannot reasonably infer.",
      "Phrase `prompt` as a complete sentence with the question and any constraints (length, format).",
      "If the user 'skipped' the input, do not retry the same request — work with what you have or tell the user you need it.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description: "Header text. Modal title is capped to 24 chars by Slack; the launcher message uses the full title.",
        minLength: 1,
        maxLength: 150,
      }),
      prompt: Type.String({
        description: "What the agent is asking for, shown above the launcher button as markdown.",
        minLength: 1,
        maxLength: 600,
      }),
      placeholder: Type.Optional(Type.String({
        description: "Placeholder shown inside the modal input field.",
        maxLength: 150,
      })),
      multiline: Type.Optional(Type.Boolean({
        description: "Multiline modal input. Default true. Set false for short single-line answers.",
      })),
      timeout_ms: Type.Optional(Type.Number({
        description: "Max wait in ms before resolving to 'timeout'. Default 600000 (10m), capped at 1800000 (30m).",
        minimum: 1000,
        maximum: 1800000,
      })),
    }),
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const ui = getSlackUI(ctx);
      if (!ui?.inputRequest) {
        return errorResult(`slack_input_request requires a Slack-bound Pi turn. ${NOT_SLACK_BOUND_HINT}`);
      }
      try {
        const text = await ui.inputRequest(params.title, params.prompt, {
          placeholder: params.placeholder,
          multiline: params.multiline !== false,
          signal,
          timeout: params.timeout_ms,
        });
        if (typeof text === "string" && text.length > 0) return textResult(text);
        if (signal?.aborted) return textResult("timeout");
        return textResult("skipped");
      } catch (err: any) {
        return errorResult(`slack_input_request failed: ${err?.message || String(err)}`);
      }
    },
  });
}
