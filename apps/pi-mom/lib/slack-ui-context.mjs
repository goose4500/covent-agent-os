// ExtensionUIContext implementation that routes Pi extension `ctx.ui.*` calls
// to Slack instead of the TUI.
//
// Pi extensions (e.g. permission-gate, env-guard, linear-mcp-guard) call
// `ctx.ui.select(title, options)` / `ctx.ui.confirm(title, message)` /
// `ctx.ui.notify(message)` to surface approvals to the human. When pi-mom binds
// this context via `session.bindExtensions({ uiContext })`, those calls fan out
// to Slack:
//
//   - select / confirm → `alert` block with buttons in the thread; the promise
//     resolves when the user clicks. The Slack action handler in index.mjs is
//     responsible for looking up the pendingApprovals Map by action_id and
//     calling the stored resolveFn.
//   - notify           → thread message
//
// TUI-only methods (setWorkingMessage, setEditorComponent, etc.) are explicit
// no-ops. The full ExtensionUIContext surface is implemented to satisfy any
// extension that probes for a method's existence.
//
// Real signatures (from
// node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:67-191):
//   select(title, options, opts?) -> Promise<string | undefined>
//   confirm(title, message, opts?) -> Promise<boolean>
//   input(title, placeholder?, opts?) -> Promise<string | undefined>
//   notify(message, type?) -> void

import { randomUUID } from "node:crypto";

const APPROVAL_TIMEOUT_MS = Number(process.env.PI_MOM_APPROVAL_TIMEOUT_MS || 600_000); // 10 min

const NOTIFY_PREFIX = {
  info: "ℹ️",
  warning: "⚠️",
  error: "❌",
};

function alertBlock({ title, body, options, approvalId }) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${title}*\n\n${body}` },
    },
    {
      type: "actions",
      block_id: `pi_approval_${approvalId}`,
      elements: options.map((option, idx) => ({
        type: "button",
        action_id: `pi_approval_choice_${idx}`,
        text: { type: "plain_text", text: option },
        value: option,
        style: idx === 0 ? "primary" : undefined,
      })),
    },
  ];
}

export function slackUI({ client, channel, threadTs, pendingApprovals }) {
  if (!client) throw new Error("slackUI: client is required");
  if (!channel) throw new Error("slackUI: channel is required");
  if (!threadTs) throw new Error("slackUI: threadTs is required");
  if (!pendingApprovals) throw new Error("slackUI: pendingApprovals Map is required");

  async function postChoice({ title, body, options }) {
    const approvalId = randomUUID();

    const message = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `${title} — ${body}`,
      blocks: alertBlock({ title, body, options, approvalId }),
    });

    return new Promise((resolveFn) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(approvalId);
        resolveFn(undefined);
      }, APPROVAL_TIMEOUT_MS);

      const handler = (choice) => {
        clearTimeout(timer);
        pendingApprovals.delete(approvalId);
        resolveFn(choice);
      };
      handler.meta = {
        ts: message.ts,
        channel,
        threadTs,
        options,
      };
      pendingApprovals.set(approvalId, handler);
    });
  }

  const noop = () => {};
  const stubTheme = {
    name: "slack-noop",
    colors: {},
  };

  return {
    // Selection dialog — shown as an `alert` block with one button per option.
    // Returns the selected option or undefined on timeout/cancel.
    async select(title, options, _opts) {
      const choices = Array.isArray(options) && options.length > 0 ? options : ["Yes", "No"];
      return postChoice({
        title: typeof title === "string" && title.length > 0 ? title : "Pi requests a choice",
        body: "",
        options: choices,
      });
    },

    // Confirmation dialog — shown as an `alert` block with Yes/No.
    // Returns true on Yes, false on No or timeout.
    async confirm(title, message, _opts) {
      const result = await postChoice({
        title: typeof title === "string" && title.length > 0 ? title : "Pi requests confirmation",
        body: typeof message === "string" ? message : "",
        options: ["Yes", "No"],
      });
      return result === "Yes";
    },

    // Text input — Slack lacks an inline input affordance, so surface the
    // prompt as a thread message and resolve to undefined. Extensions that
    // need free-form input from Slack must drive a modal themselves.
    async input(title, placeholder, _opts) {
      const titleText = typeof title === "string" && title.length > 0 ? title : "Pi asks";
      const placeholderText = typeof placeholder === "string" && placeholder.length > 0
        ? `\n_Hint: ${placeholder}_`
        : "";
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `🤖 ${titleText}${placeholderText}\n_Reply in this thread to answer._`,
      });
      return undefined;
    },

    // Non-blocking notification — fire-and-forget thread message. Per Pi
    // semantics this returns void (synchronously).
    notify(message, type) {
      const prefix = NOTIFY_PREFIX[type] ?? NOTIFY_PREFIX.info;
      client.chat
        .postMessage({
          channel,
          thread_ts: threadTs,
          text: `${prefix} ${message}`,
        })
        .catch(() => {
          // swallow — notify is fire-and-forget
        });
    },

    // ---- TUI-only surface: no-ops in the Slack host ----
    onTerminalInput() {
      return noop;
    },
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    async custom() {
      return undefined;
    },
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText() {
      return "";
    },
    async editor() {
      return undefined;
    },
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent() {
      return undefined;
    },
    get theme() {
      return stubTheme;
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "theme switching is not supported in the Slack host" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded: noop,
  };
}

// Slack action handler glue — index.mjs invokes this when a pi_approval_choice_*
// button is clicked. Resolves the corresponding pending promise.
export function resolveSlackApproval({ pendingApprovals, blockId, value }) {
  const approvalId = blockId?.startsWith("pi_approval_") ? blockId.slice("pi_approval_".length) : null;
  if (!approvalId) return false;
  const resolveFn = pendingApprovals.get(approvalId);
  if (!resolveFn) return false;
  resolveFn(value);
  return true;
}
