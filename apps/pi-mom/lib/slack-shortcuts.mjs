export const THREAD_SPEC_MESSAGE_SHORTCUT_CALLBACK_ID = "pi_thread_spec_message";
export const THREAD_SPEC_GLOBAL_SHORTCUT_CALLBACK_ID = "pi_thread_spec_global";
export const THREAD_SPEC_GLOBAL_MODAL_CALLBACK_ID = "pi_thread_spec_global_modal";

export const THREAD_SPEC_URL_BLOCK_ID = "thread_spec_url_block";
export const THREAD_SPEC_URL_ACTION_ID = "thread_spec_url";
export const THREAD_SPEC_FOCUS_BLOCK_ID = "thread_spec_focus_block";
export const THREAD_SPEC_FOCUS_ACTION_ID = "thread_spec_focus";

export const DEFAULT_THREAD_SPEC_FOCUS = "Turn this Slack thread into a concise PRD/spec draft.";

export function buildThreadSpecGlobalShortcutModalView() {
  return {
    type: "modal",
    callback_id: THREAD_SPEC_GLOBAL_MODAL_CALLBACK_ID,
    title: { type: "plain_text", text: "Draft thread spec" },
    submit: { type: "plain_text", text: "Draft" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: THREAD_SPEC_URL_BLOCK_ID,
        label: { type: "plain_text", text: "Slack message or thread URL" },
        element: {
          type: "plain_text_input",
          action_id: THREAD_SPEC_URL_ACTION_ID,
          placeholder: { type: "plain_text", text: "https://…/archives/C…/p…" },
        },
      },
      {
        type: "input",
        block_id: THREAD_SPEC_FOCUS_BLOCK_ID,
        optional: true,
        label: { type: "plain_text", text: "Optional focus" },
        element: {
          type: "plain_text_input",
          action_id: THREAD_SPEC_FOCUS_ACTION_ID,
          multiline: true,
          placeholder: { type: "plain_text", text: "Anything specific the spec should cover?" },
        },
      },
    ],
  };
}

function getViewValue(view, blockId, actionId) {
  return view?.state?.values?.[blockId]?.[actionId]?.value?.trim() || "";
}

export function extractThreadSpecGlobalShortcutSubmission(view = {}) {
  return {
    threadUrl: getViewValue(view, THREAD_SPEC_URL_BLOCK_ID, THREAD_SPEC_URL_ACTION_ID),
    focus: getViewValue(view, THREAD_SPEC_FOCUS_BLOCK_ID, THREAD_SPEC_FOCUS_ACTION_ID),
  };
}

export function getThreadSpecMessageShortcutTarget(shortcut = {}) {
  const channel = shortcut.channel?.id || shortcut.channel_id || shortcut.message?.channel;
  const user = shortcut.user?.id || shortcut.user_id;
  const message = shortcut.message || {};
  const threadTs = message.thread_ts || message.ts;
  const team = shortcut.team?.id || shortcut.team_id || shortcut.team?.domain || "";

  if (!channel || !user || !threadTs) return undefined;
  return { channel, user, threadTs, messageTs: message.ts || threadTs, team };
}

export function buildThreadSpecEvent({ channel, user, threadTs, focus, team } = {}) {
  return {
    channel,
    user,
    ts: threadTs,
    thread_ts: threadTs,
    text: `spec: ${focus?.trim() || DEFAULT_THREAD_SPEC_FOCUS}`,
    team,
    team_id: team,
  };
}
