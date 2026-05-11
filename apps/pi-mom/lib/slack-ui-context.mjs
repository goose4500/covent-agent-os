// ExtensionUIContext implementation that routes Pi extension `ctx.ui.*` calls
// to Slack instead of the TUI.
//
// Pi extensions (e.g. permission-gate, env-guard, linear-mcp-guard) call
// `ctx.ui.select(prompt, choices)` / `ctx.ui.confirm(text)` / `ctx.ui.notify(text)`
// to surface approvals to the human. When pi-mom binds this context via
// `session.bindExtensions({ uiContext })`, those calls fan out to Slack:
//
//   - select / confirm → `alert` block with buttons in the thread; the promise
//     resolves when the user clicks. The Slack action handler in index.mjs is
//     responsible for looking up the pendingApprovals Map by action_id and
//     calling the stored resolveFn.
//   - notify           → `chat.postEphemeral`
//
// TUI-only methods (setWidget, setEditorComponent, etc.) are explicit no-ops.
// Per pi.dev/docs/latest/sdk: `ctx.hasUI` auto-returns true once
// bindExtensions({ uiContext }) is called with a non-undefined context.

import { randomUUID } from "node:crypto";

const APPROVAL_TIMEOUT_MS = Number(process.env.PI_MOM_APPROVAL_TIMEOUT_MS || 600_000); // 10 min

function alertBlock({ title, body, choices, approvalId }) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${title}*\n\n${body}` },
    },
    {
      type: "actions",
      block_id: `pi_approval_${approvalId}`,
      elements: choices.map((choice, idx) => ({
        type: "button",
        action_id: `pi_approval_choice_${idx}`,
        text: { type: "plain_text", text: choice },
        value: choice,
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

  async function postChoice({ title, body, choices }) {
    const approvalId = randomUUID();

    const message = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `${title} — ${body}`,
      blocks: alertBlock({ title, body, choices, approvalId }),
    });

    return new Promise((resolveFn) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(approvalId);
        resolveFn(null);
      }, APPROVAL_TIMEOUT_MS);

      pendingApprovals.set(approvalId, (choice) => {
        clearTimeout(timer);
        pendingApprovals.delete(approvalId);
        resolveFn(choice);
      });

      pendingApprovals.get(approvalId).meta = {
        ts: message.ts,
        channel,
        threadTs,
        choices,
      };
    });
  }

  return {
    async select(prompt, choices) {
      const result = await postChoice({
        title: "Pi requests a choice",
        body: prompt,
        choices: Array.isArray(choices) ? choices : ["Yes", "No"],
      });
      return result ?? choices[choices.length - 1]; // timeout = last (usually "No")
    },

    async confirm(text) {
      const result = await postChoice({
        title: "Pi requests confirmation",
        body: text,
        choices: ["Yes", "No"],
      });
      return result === "Yes";
    },

    async input(prompt) {
      // Slack-side text input is best done via a modal (views.open). For MVP
      // we surface the prompt as a thread message and instruct the user to
      // reply; index.mjs picks up the next reply and pipes it back via
      // pendingApprovals (same channel, different choice shape). This is a
      // soft fallback — richer modal flow lands in PR 2 if needed.
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `🤖 Pi asks: ${prompt}\n_Reply in this thread to answer._`,
      });
      return ""; // caller decides what to do with empty input
    },

    async notify(text) {
      // Best-effort ephemeral; if no user context is available, fall back to
      // a thread message. The extensions call notify for non-blocking signals.
      try {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `ℹ️ ${text}`,
        });
      } catch {
        // swallow — notify is fire-and-forget per Pi semantics
      }
    },

    // TUI-only — no-ops in Slack host. Pi's RPC reference impl does the same.
    setWidget() {},
    setEditorComponent() {},
    setStatus() {},
    clearStatus() {},
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
