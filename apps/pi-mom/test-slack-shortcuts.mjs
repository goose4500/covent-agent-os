import assert from "node:assert/strict";
import {
  buildThreadSpecEvent,
  buildThreadSpecGlobalShortcutModalView,
  extractThreadSpecGlobalShortcutSubmission,
  getThreadSpecMessageShortcutTarget,
  THREAD_SPEC_FOCUS_ACTION_ID,
  THREAD_SPEC_FOCUS_BLOCK_ID,
  THREAD_SPEC_GLOBAL_MODAL_CALLBACK_ID,
  THREAD_SPEC_URL_ACTION_ID,
  THREAD_SPEC_URL_BLOCK_ID,
} from "./lib/slack-shortcuts.mjs";

// Case 1: global shortcut modal has the expected callback and input blocks.
{
  const view = buildThreadSpecGlobalShortcutModalView();
  assert.equal(view.type, "modal");
  assert.equal(view.callback_id, THREAD_SPEC_GLOBAL_MODAL_CALLBACK_ID);
  assert.ok(view.blocks.find((b) => b.block_id === THREAD_SPEC_URL_BLOCK_ID), "URL input block exists");
  assert.ok(view.blocks.find((b) => b.block_id === THREAD_SPEC_FOCUS_BLOCK_ID), "focus input block exists");
}

// Case 2: modal submission extraction returns trimmed URL/focus values.
{
  const result = extractThreadSpecGlobalShortcutSubmission({
    state: {
      values: {
        [THREAD_SPEC_URL_BLOCK_ID]: {
          [THREAD_SPEC_URL_ACTION_ID]: { value: "  https://covent.slack.com/archives/C123/p1778823767948129  " },
        },
        [THREAD_SPEC_FOCUS_BLOCK_ID]: {
          [THREAD_SPEC_FOCUS_ACTION_ID]: { value: "  include risks  " },
        },
      },
    },
  });
  assert.deepEqual(result, {
    threadUrl: "https://covent.slack.com/archives/C123/p1778823767948129",
    focus: "include risks",
  });
}

// Case 3: message shortcut target resolves a reply back to the root thread.
{
  const target = getThreadSpecMessageShortcutTarget({
    channel: { id: "C0B05VBGJKF" },
    user: { id: "U123" },
    team: { id: "T123" },
    message: { ts: "1778823887.257859", thread_ts: "1778823767.948129" },
  });
  assert.deepEqual(target, {
    channel: "C0B05VBGJKF",
    user: "U123",
    threadTs: "1778823767.948129",
    messageTs: "1778823887.257859",
    team: "T123",
  });
}

// Case 4: missing channel/user/thread data is rejected.
{
  assert.equal(getThreadSpecMessageShortcutTarget({ message: { ts: "1.2" } }), undefined);
}

// Case 5: thread-spec event uses the same spec route text as slash command routing.
{
  const event = buildThreadSpecEvent({
    channel: "C123",
    user: "U123",
    threadTs: "1.2",
    focus: "include acceptance criteria",
    team: "T123",
  });
  assert.deepEqual(event, {
    channel: "C123",
    user: "U123",
    ts: "1.2",
    thread_ts: "1.2",
    text: "spec: include acceptance criteria",
    team: "T123",
    team_id: "T123",
  });
}

console.log("slack shortcut tests passed");
