import assert from "node:assert/strict";
import {
  createSlackUIContext,
  resolveSelectAction,
  resolveConfirmAction,
  resolveInputSubmission,
  resolveInputCancel,
  buildInputModalView,
  _resetApprovalCounterForTests,
} from "./lib/slack-ui-context.mjs";

function makeFakeClient() {
  const postMessages = [];
  const updates = [];
  const viewsOpened = [];
  return {
    postMessages,
    updates,
    viewsOpened,
    chat: {
      postMessage: async (args) => {
        const ts = `${(postMessages.length + 1).toString().padStart(3, "0")}.000${postMessages.length}`;
        postMessages.push({ ...args, ts });
        return { ok: true, ts, channel: args.channel };
      },
      update: async (args) => {
        updates.push(args);
        return { ok: true };
      },
    },
    views: {
      open: async (args) => {
        viewsOpened.push(args);
        return { ok: true, view: args.view };
      },
    },
  };
}

function makeTimerHarness() {
  const timers = [];
  return {
    timers,
    setTimeoutFn: (fn, ms) => { const id = timers.length; timers.push({ id, fn, ms, cleared: false }); return id; },
    clearTimeoutFn: (id) => { if (timers[id]) timers[id].cleared = true; },
    fire: async (id) => { const t = timers[id]; if (t && !t.cleared) await t.fn(); },
  };
}

// Case 1: confirm() posts a blocks message, registers entry, resolves true on Approve.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const traces = [];
  const trace = (event, data) => traces.push({ event, data });
  const ui = createSlackUIContext({
    client, channel: "C1", threadTs: "1.0",
    requestId: "req_c1", pendingApprovals, surface: "app_mention", trace,
  });

  const pending = ui.confirm("Approve bash?", "rm -rf /tmp/test");
  await new Promise((r) => setImmediate(r));

  assert.equal(client.postMessages.length, 1, "exactly one postMessage");
  const posted = client.postMessages[0];
  assert.equal(posted.channel, "C1");
  assert.equal(posted.thread_ts, "1.0");
  assert.ok(posted.blocks.find((b) => b.type === "actions"), "has actions block");
  const approveBtn = posted.blocks.find((b) => b.type === "actions").elements.find((e) => e.action_id === "pi_uictx_confirm_approve");
  assert.ok(approveBtn, "approve button present");
  assert.match(approveBtn.value, /^appr_req_c1_/);

  // Registered exactly one entry.
  assert.equal(pendingApprovals.size, 1);
  const [[approvalId, entry]] = [...pendingApprovals.entries()];
  assert.equal(entry.type, "confirm");
  assert.equal(entry.requestId, "req_c1");
  assert.equal(entry.messageTs, posted.ts);

  // Simulate the action handler invoking resolveConfirmAction.
  const ok = resolveConfirmAction({
    pendingApprovals,
    action: { action_id: "pi_uictx_confirm_approve", value: approvalId },
    body: { user: { id: "U_TESTER" } },
    client,
    trace,
  });
  assert.equal(ok, true);
  const result = await pending;
  assert.equal(result, true, "confirm resolves true on approve");
  assert.equal(pendingApprovals.size, 0, "entry cleaned up");
  assert.equal(client.updates.length, 1, "launcher message edited");
  assert.match(client.updates[0].text, /approved/);
}

// Case 2: confirm() resolves false on Cancel.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C2", threadTs: "2.0",
    requestId: "req_c2", pendingApprovals,
  });
  const pending = ui.confirm("Risky?", "delete db");
  await new Promise((r) => setImmediate(r));
  const approvalId = [...pendingApprovals.keys()][0];
  resolveConfirmAction({
    pendingApprovals,
    action: { action_id: "pi_uictx_confirm_cancel", value: approvalId },
    body: { user: { id: "U2" } },
    client,
  });
  assert.equal(await pending, false);
  assert.match(client.updates[0].text, /canceled/);
}

// Case 3: select() posts one button per option, resolveSelectAction returns the chosen string.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C3", threadTs: "3.0",
    requestId: "req_s3", pendingApprovals,
  });
  const pending = ui.select("⚠️ Dangerous command:\n\n  rm -rf /\n\nAllow?", ["Yes", "No"]);
  await new Promise((r) => setImmediate(r));
  const posted = client.postMessages[0];
  const buttons = posted.blocks.find((b) => b.type === "actions").elements;
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].action_id, "pi_uictx_select_0");
  assert.equal(buttons[1].action_id, "pi_uictx_select_1");
  const approvalId = [...pendingApprovals.keys()][0];

  // Click "No" (index 1).
  const ok = resolveSelectAction({
    pendingApprovals,
    action: { action_id: "pi_uictx_select_1", value: `${approvalId}:1` },
    body: { user: { id: "U3" } },
    client,
  });
  assert.equal(ok, true);
  assert.equal(await pending, "No", "select returns chosen option string");
  assert.equal(pendingApprovals.size, 0);
}

// Case 4: select() respects opts.signal abort (default value undefined).
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C4", threadTs: "4.0",
    requestId: "req_s4", pendingApprovals,
  });
  const ac = new AbortController();
  const pending = ui.select("Pick", ["A", "B"], { signal: ac.signal });
  await new Promise((r) => setImmediate(r));
  assert.equal(pendingApprovals.size, 1);
  ac.abort();
  assert.equal(await pending, undefined, "abort resolves with default (undefined)");
  assert.equal(pendingApprovals.size, 0, "abort cleans up entry");
}

// Case 5: confirm() respects opts.timeout (default false).
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const T = makeTimerHarness();
  const ui = createSlackUIContext({
    client, channel: "C5", threadTs: "5.0",
    requestId: "req_c5", pendingApprovals,
    setTimeoutFn: T.setTimeoutFn,
    clearTimeoutFn: T.clearTimeoutFn,
  });
  const pending = ui.confirm("Timeout test", "msg", { timeout: 1000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(T.timers.length, 1, "timeout timer registered");
  await T.fire(0);
  assert.equal(await pending, false, "timeout resolves with default false");
  assert.equal(pendingApprovals.size, 0);
}

// Case 6: input() posts launcher with two buttons; submission via resolveInputSubmission returns value.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C6", threadTs: "6.0",
    requestId: "req_i6", pendingApprovals,
  });
  const pending = ui.input("Issue title", "e.g. Slack outage 5/11");
  await new Promise((r) => setImmediate(r));
  const posted = client.postMessages[0];
  const buttons = posted.blocks.find((b) => b.type === "actions").elements;
  assert.equal(buttons[0].action_id, "pi_uictx_input_launch");
  assert.equal(buttons[1].action_id, "pi_uictx_input_skip");
  const approvalId = [...pendingApprovals.keys()][0];

  // Simulate view_submission.
  const ok = resolveInputSubmission({
    pendingApprovals,
    view: {
      private_metadata: approvalId,
      state: { values: { pi_uictx_input_block: { pi_uictx_input_value: { value: "Slack streaming retention bug" } } } },
    },
    body: { user: { id: "U6" } },
    client,
  });
  assert.equal(ok, true);
  assert.equal(await pending, "Slack streaming retention bug");
}

// Case 7: input() resolveInputCancel resolves undefined.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C7", threadTs: "7.0",
    requestId: "req_i7", pendingApprovals,
  });
  const pending = ui.input("Title", "");
  await new Promise((r) => setImmediate(r));
  const approvalId = [...pendingApprovals.keys()][0];
  const ok = resolveInputCancel({
    pendingApprovals,
    view: { private_metadata: approvalId },
    body: { user: { id: "U7" } },
    client,
  });
  assert.equal(ok, true);
  assert.equal(await pending, undefined);
}

// Case 8: notify() posts a chat message with the icon prefix.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C8", threadTs: "8.0",
    requestId: "req_n8", pendingApprovals,
  });
  ui.notify("Backup complete", "info");
  ui.notify("Disk almost full", "warning");
  ui.notify("Auth failure", "error");
  await new Promise((r) => setImmediate(r));
  assert.equal(client.postMessages.length, 3);
  assert.match(client.postMessages[0].text, /^ℹ️/);
  assert.match(client.postMessages[1].text, /^⚠️/);
  assert.match(client.postMessages[2].text, /^🛑/);
}

// Case 9: setStatus() forwards to assistantSetStatus only when surface==='assistant'.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const calls = [];
  const assistantSetStatus = async (text) => { calls.push(text); };
  const uiAssistant = createSlackUIContext({
    client, channel: "C9", threadTs: "9.0",
    requestId: "req_st9", pendingApprovals, surface: "assistant", assistantSetStatus,
  });
  uiAssistant.setStatus("permission-gate", "Waiting on approval…");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["Waiting on approval…"]);

  const uiMention = createSlackUIContext({
    client, channel: "C9b", threadTs: "9.0b",
    requestId: "req_st9b", pendingApprovals, surface: "app_mention", assistantSetStatus,
  });
  uiMention.setStatus("k", "no-op");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["Waiting on approval…"], "app_mention surface does not invoke assistantSetStatus");
}

// Case 10: dispose() resolves all owned pending entries with their default values.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C10", threadTs: "10.0",
    requestId: "req_d10", pendingApprovals,
  });
  const a = ui.confirm("a?", "ax");
  const b = ui.select("b?", ["x", "y"]);
  const c = ui.input("c?");
  await new Promise((r) => setImmediate(r));
  assert.equal(pendingApprovals.size, 3);
  ui.dispose("session_end");
  assert.equal(await a, false, "confirm default false");
  assert.equal(await b, undefined, "select default undefined");
  assert.equal(await c, undefined, "input default undefined");
  assert.equal(pendingApprovals.size, 0);
}

// Case 11: buildInputModalView shape — private_metadata = approvalId, multiline input, notify_on_close.
{
  const view = buildInputModalView({ approvalId: "appr_X", title: "Title here", placeholder: "Hint" });
  assert.equal(view.callback_id, "pi_uictx_input_modal");
  assert.equal(view.private_metadata, "appr_X");
  assert.equal(view.notify_on_close, true);
  assert.equal(view.blocks[0].block_id, "pi_uictx_input_block");
  assert.equal(view.blocks[0].element.action_id, "pi_uictx_input_value");
  assert.equal(view.blocks[0].element.multiline, true);
  assert.equal(view.blocks[0].element.placeholder.text, "Hint");
}

// Case 12: factory throws on missing required deps.
{
  assert.throws(() => createSlackUIContext({ pendingApprovals: new Map(), channel: "x", threadTs: "y", requestId: "z" }), /client/);
  assert.throws(() => createSlackUIContext({ client: { chat: { postMessage: () => {} } }, channel: "x", threadTs: "y", requestId: "z" }), /pendingApprovals/);
  assert.throws(() => createSlackUIContext({ client: { chat: { postMessage: () => {} } }, pendingApprovals: new Map(), threadTs: "y", requestId: "z" }), /channel/);
}

// Case 13: resolveSelectAction returns false for unknown approvalId (button click after timeout/abort cleanup).
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ok = resolveSelectAction({
    pendingApprovals,
    action: { action_id: "pi_uictx_select_0", value: "appr_ghost:0" },
    body: { user: { id: "U" } },
    client,
  });
  assert.equal(ok, false, "no entry → handler is a no-op");
  assert.equal(client.updates.length, 0);
}

// Case 14: confirmWithPreview posts header + summary + preview + buttons; reuses pi_uictx_confirm_* handlers.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C14", threadTs: "14.0",
    requestId: "req_p14", pendingApprovals,
  });

  const pending = ui.confirmWithPreview(
    "Create Linear issue?",
    "Filing in Backlog/FE",
    "**Title:** Stream rotation bug\n\nDescription...",
    { approveLabel: "File it", rejectLabel: "Hold" },
  );
  await new Promise((r) => setImmediate(r));

  assert.equal(client.postMessages.length, 1);
  const posted = client.postMessages[0];
  // Blocks in order: header, section(summary), divider, section(preview), context, actions.
  assert.equal(posted.blocks[0].type, "header");
  assert.equal(posted.blocks[0].text.text, "Create Linear issue?");
  assert.equal(posted.blocks[1].type, "section");
  assert.match(posted.blocks[1].text.text, /Filing in Backlog/);
  assert.equal(posted.blocks[2].type, "divider");
  assert.equal(posted.blocks[3].type, "section");
  assert.match(posted.blocks[3].text.text, /Stream rotation bug/);
  assert.equal(posted.blocks[4].type, "context");
  assert.equal(posted.blocks[5].type, "actions");

  const approveBtn = posted.blocks[5].elements.find((e) => e.action_id === "pi_uictx_confirm_approve");
  const cancelBtn = posted.blocks[5].elements.find((e) => e.action_id === "pi_uictx_confirm_cancel");
  assert.ok(approveBtn && cancelBtn, "approve+cancel buttons present");
  assert.equal(approveBtn.text.text, "File it");
  assert.equal(cancelBtn.text.text, "Hold");
  assert.equal(approveBtn.style, "primary");
  assert.equal(cancelBtn.style, "danger");

  // Resolve via existing handler.
  const [[approvalId]] = [...pendingApprovals.entries()];
  resolveConfirmAction({
    pendingApprovals,
    action: { action_id: "pi_uictx_confirm_approve", value: approvalId },
    body: { user: { id: "U" } },
    client,
  });
  assert.equal(await pending, true);
  assert.equal(pendingApprovals.size, 0);
}

// Case 15: confirmWithPreview resolves false on Cancel.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C15", threadTs: "15.0",
    requestId: "req_p15", pendingApprovals,
  });

  const pending = ui.confirmWithPreview("X", "Y", "Z");
  await new Promise((r) => setImmediate(r));
  const [[approvalId]] = [...pendingApprovals.entries()];
  resolveConfirmAction({
    pendingApprovals,
    action: { action_id: "pi_uictx_confirm_cancel", value: approvalId },
    body: { user: { id: "U" } },
    client,
  });
  assert.equal(await pending, false);
}

// Case 16: selectWithContext posts per-option section+actions blocks; resolves to id (not label).
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C16", threadTs: "16.0",
    requestId: "req_p16", pendingApprovals,
  });

  const options = [
    { id: "fe-100", label: "FE-100", context_md: "*FE-100* — Stream rotation bug (Backlog)" },
    { id: "fe-99", label: "FE-99", context_md: "*FE-99* — Slack streaming retry (In Progress)" },
    { id: "fe-12", label: "FE-12" }, // No context_md.
  ];
  const pending = ui.selectWithContext("Pick a Linear issue", "Found 3 matches", options);
  await new Promise((r) => setImmediate(r));

  const posted = client.postMessages[0];
  assert.equal(posted.blocks[0].type, "header");
  assert.equal(posted.blocks[1].type, "section");
  assert.match(posted.blocks[1].text.text, /Found 3 matches/);
  assert.equal(posted.blocks[2].type, "divider");

  // Each option emits its own section (if context_md present) + actions block.
  // Expected per option: option 1 → section + actions, option 2 → section + actions, option 3 → actions only (no context).
  // Followed by a single trailing context block (req · approval).
  const trailing = posted.blocks[posted.blocks.length - 1];
  assert.equal(trailing.type, "context");

  const buttons = posted.blocks
    .filter((b) => b.type === "actions")
    .flatMap((b) => b.elements);
  assert.equal(buttons.length, 3, "one button per option");
  assert.equal(buttons[0].action_id, "pi_uictx_select_0");
  assert.equal(buttons[1].action_id, "pi_uictx_select_1");
  assert.equal(buttons[2].action_id, "pi_uictx_select_2");
  assert.equal(buttons[0].style, "primary");
  // Each button value is `${approvalId}:${idx}`.
  const [[approvalId]] = [...pendingApprovals.entries()];
  assert.equal(buttons[1].value, `${approvalId}:1`);

  // Resolve via the existing select handler — should return the id, not the label.
  resolveSelectAction({
    pendingApprovals,
    action: { action_id: "pi_uictx_select_1", value: `${approvalId}:1` },
    body: { user: { id: "U" } },
    client,
  });
  const result = await pending;
  assert.equal(result, "fe-99", "resolves to opaque id");
  // The outcome message edit should use the human label, not the id.
  assert.match(client.updates[0].text, /FE-99/);
}

// Case 17: backward-compat — flat select() still resolves to label, not id.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C17", threadTs: "17.0",
    requestId: "req_p17", pendingApprovals,
  });

  const pending = ui.select("Pick", ["Yes", "No", "Maybe"]);
  await new Promise((r) => setImmediate(r));
  const [[approvalId]] = [...pendingApprovals.entries()];
  resolveSelectAction({
    pendingApprovals,
    action: { action_id: "pi_uictx_select_2", value: `${approvalId}:2` },
    body: { user: { id: "U" } },
    client,
  });
  assert.equal(await pending, "Maybe", "flat select still resolves to label");
}

// Case 18: inputRequest posts header + prompt section + launcher buttons; resolves via existing input handlers.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C18", threadTs: "18.0",
    requestId: "req_p18", pendingApprovals,
  });

  const pending = ui.inputRequest(
    "What's the issue priority?",
    "Pick *one* of P0–P4 with a one-line justification.",
    { placeholder: "P1 — blocks release", multiline: false },
  );
  await new Promise((r) => setImmediate(r));

  const posted = client.postMessages[0];
  assert.equal(posted.blocks[0].type, "header");
  assert.equal(posted.blocks[1].type, "section");
  assert.match(posted.blocks[1].text.text, /P0–P4/);
  const launchBtn = posted.blocks
    .filter((b) => b.type === "actions")
    .flatMap((b) => b.elements)
    .find((e) => e.action_id === "pi_uictx_input_launch");
  assert.ok(launchBtn, "launcher button present");
  const skipBtn = posted.blocks
    .filter((b) => b.type === "actions")
    .flatMap((b) => b.elements)
    .find((e) => e.action_id === "pi_uictx_input_skip");
  assert.ok(skipBtn, "skip button present");

  // Resolve via existing input submission helper.
  const [[approvalId, entry]] = [...pendingApprovals.entries()];
  assert.equal(entry.type, "input");
  assert.equal(entry.multiline, false);
  assert.equal(entry.placeholder, "P1 — blocks release");

  resolveInputSubmission({
    pendingApprovals,
    view: {
      private_metadata: approvalId,
      state: { values: { pi_uictx_input_block: { pi_uictx_input_value: { value: "P1 — blocks the launch" } } } },
    },
    body: { user: { id: "U" } },
    client,
  });
  assert.equal(await pending, "P1 — blocks the launch");
}

// Case 19: inputRequest "Skip" path resolves to undefined.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C19", threadTs: "19.0",
    requestId: "req_p19", pendingApprovals,
  });

  const pending = ui.inputRequest("Title?", "Give me a one-liner");
  await new Promise((r) => setImmediate(r));
  const [[approvalId]] = [...pendingApprovals.entries()];
  resolveInputCancel({
    pendingApprovals,
    view: { private_metadata: approvalId },
    body: { user: { id: "U" } },
    client,
  });
  assert.equal(await pending, undefined);
}

// Case 20: postFile uploads via filesUploadV2 and posts a follow-up Card+Context
// block message — no initial_comment, no actions row.
{
  _resetApprovalCounterForTests();
  const fs = await import("node:fs/promises");
  const tmp = await import("node:os").then((m) => m.tmpdir());
  const path = `${tmp}/pi-postfile-${Date.now()}-1.csv`;
  await fs.writeFile(path, "a,b,c\n1,2,3\n");

  const client = makeFakeClient();
  const uploads = [];
  client.filesUploadV2 = async (args) => {
    uploads.push(args);
    return { ok: true, files: [{ id: "F123", files: [{ id: "F123", permalink: "https://slack/F123" }] }] };
  };
  const pendingApprovals = new Map();
  const traces = [];
  const ui = createSlackUIContext({
    client, channel: "C20", threadTs: "20.0",
    requestId: "req_p20", pendingApprovals,
    trace: (event, data) => traces.push({ event, data }),
  });

  const result = await ui.postFile("sales.csv", path, "text/csv", {
    description: "Three rows of sample sales data",
  });
  assert.equal(result.ok, true);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].channel_id, "C20");
  assert.equal(uploads[0].thread_ts, "20.0");
  assert.equal(uploads[0].file, path);
  assert.equal(uploads[0].filename, "sales.csv");
  assert.equal(uploads[0].initial_comment, undefined, "no initial_comment — the Card carries the metadata");

  assert.equal(client.postMessages.length, 1, "one follow-up posted with Card + Context");
  const followup = client.postMessages[0];
  assert.equal(followup.channel, "C20");
  assert.equal(followup.thread_ts, "20.0");
  const card = followup.blocks.find((b) => b.type === "card");
  assert.ok(card, "Card block present");
  assert.equal(card.title.type, "mrkdwn");
  assert.match(card.title.text, /\*sales\.csv\*/);
  assert.match(card.subtitle.text, /CSV/);
  assert.match(card.subtitle.text, /\d+ (B|KB|MB)/);
  assert.equal(card.body.text, "Three rows of sample sales data");
  assert.equal(card.actions, undefined, "no actions row in the Card");
  const context = followup.blocks.find((b) => b.type === "context");
  assert.ok(context, "context block present");
  assert.match(context.elements[0].text, /Generated by Pi/);
  assert.match(context.elements[0].text, /req_p20/);

  await fs.unlink(path);
}

// Case 21: postFile omits Card body when description is missing, and falls back
// to filename extension for the format label when mime_type is unknown.
{
  _resetApprovalCounterForTests();
  const fs = await import("node:fs/promises");
  const tmp = await import("node:os").then((m) => m.tmpdir());
  const path = `${tmp}/pi-postfile-${Date.now()}-2.parquet`;
  await fs.writeFile(path, "x".repeat(2048));

  const client = makeFakeClient();
  client.filesUploadV2 = async () => ({ ok: true, files: [{ id: "F2", files: [{ id: "F2" }] }] });
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C21", threadTs: "21.0",
    requestId: "req_p21", pendingApprovals,
  });

  const result = await ui.postFile("data.parquet", path);
  assert.equal(result.ok, true);
  const card = client.postMessages[0].blocks.find((b) => b.type === "card");
  assert.equal(card.body, undefined, "body omitted when no description");
  assert.match(card.subtitle.text, /PARQUET/);
  assert.match(card.subtitle.text, /2\.0 KB/);

  await fs.unlink(path);
}

// Case 22: postFile fail-soft when filesUploadV2 throws — returns { ok:false } and traces.
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  client.filesUploadV2 = async () => { throw Object.assign(new Error("network"), { data: { error: "file_uploads_blocked" } }); };
  const pendingApprovals = new Map();
  const traces = [];
  const ui = createSlackUIContext({
    client, channel: "C22", threadTs: "22.0",
    requestId: "req_p22", pendingApprovals,
    trace: (event, data) => traces.push({ event, data }),
  });

  const result = await ui.postFile("x.txt", "/tmp/x.txt");
  assert.equal(result.ok, false);
  assert.equal(result.error, "file_uploads_blocked");
  assert.ok(traces.some((t) => t.event === "slack_ui.postFile_failed"));
}

// Case 23: postFile returns { ok:false, error:'ui_disposed' } after dispose().
{
  _resetApprovalCounterForTests();
  const client = makeFakeClient();
  client.filesUploadV2 = async () => ({ ok: true, files: [] });
  const pendingApprovals = new Map();
  const ui = createSlackUIContext({
    client, channel: "C23", threadTs: "23.0",
    requestId: "req_p23", pendingApprovals,
  });
  ui.dispose();
  const result = await ui.postFile("a.csv", "/tmp/a.csv");
  assert.equal(result.ok, false);
  assert.equal(result.error, "ui_disposed");
}

// --- postPreview cases ----------------------------------------------------
// postPreview uploads a zipped HTML bundle to the preview-host service over
// the Railway private network, then posts the returned public URL into the
// current Slack thread. The bridge reads PREVIEW_BASE_INTERNAL and
// PREVIEW_SHARED_SECRET from process.env; tests set/restore them around each
// case, and globalThis.fetch is patched to assert the request shape.

// Pass `null` to delete a var; omit the key to use the default; pass a string
// to set explicitly. (Default destructuring + `undefined` ignores undefined,
// so we use `null` as the explicit-delete sentinel.)
async function withPreviewEnv(overrides = {}, fn) {
  const baseInternal = "baseInternal" in overrides ? overrides.baseInternal : "http://covent-pi-preview.railway.internal:8080";
  const secret = "secret" in overrides ? overrides.secret : "test-secret";
  const prev = {
    base: process.env.PREVIEW_BASE_INTERNAL,
    secret: process.env.PREVIEW_SHARED_SECRET,
    fetch: globalThis.fetch,
  };
  if (baseInternal === null) delete process.env.PREVIEW_BASE_INTERNAL;
  else process.env.PREVIEW_BASE_INTERNAL = baseInternal;
  if (secret === null) delete process.env.PREVIEW_SHARED_SECRET;
  else process.env.PREVIEW_SHARED_SECRET = secret;
  try {
    return await fn();
  } finally {
    if (prev.base === undefined) delete process.env.PREVIEW_BASE_INTERNAL;
    else process.env.PREVIEW_BASE_INTERNAL = prev.base;
    if (prev.secret === undefined) delete process.env.PREVIEW_SHARED_SECRET;
    else process.env.PREVIEW_SHARED_SECRET = prev.secret;
    globalThis.fetch = prev.fetch;
  }
}

// Case 24: postPreview happy path — zips a single-file source, PUTs to the
// preview-host with the secret header, posts the returned URL into the thread.
{
  _resetApprovalCounterForTests();
  const fs = await import("node:fs/promises");
  const tmp = await import("node:os").then((m) => m.tmpdir());
  const filePath = `${tmp}/pi-postpreview-${Date.now()}-1.html`;
  await fs.writeFile(filePath, "<!doctype html><html><body>preview</body></html>");

  await withPreviewEnv({}, async () => {
    const captured = [];
    globalThis.fetch = async (url, init) => {
      captured.push({ url, method: init?.method, headers: init?.headers, bodyBytes: init?.body?.byteLength ?? 0 });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "abc12345", url: "https://covent-pi-preview.up.railway.app/p/abc12345/" }),
        text: async () => "",
      };
    };

    const client = makeFakeClient();
    const pendingApprovals = new Map();
    const traces = [];
    const ui = createSlackUIContext({
      client, channel: "C24", threadTs: "24.0",
      requestId: "req_pp24", pendingApprovals,
      trace: (event, data) => traces.push({ event, data }),
    });

    const result = await ui.postPreview("Color Picker", filePath, { description: "HSL sliders, no deps" });
    assert.equal(result.ok, true);
    assert.equal(result.id, "abc12345");
    assert.equal(result.url, "https://covent-pi-preview.up.railway.app/p/abc12345/");

    assert.equal(captured.length, 1, "exactly one fetch call");
    assert.match(captured[0].url, /covent-pi-preview\.railway\.internal:8080\/upload$/);
    assert.equal(captured[0].method, "PUT");
    assert.equal(captured[0].headers["content-type"], "application/zip");
    assert.equal(captured[0].headers["x-preview-secret"], "test-secret");
    assert.ok(captured[0].bodyBytes > 0, "zip body has bytes");

    assert.equal(client.postMessages.length, 1);
    assert.match(client.postMessages[0].text, /Color Picker/);
    assert.match(client.postMessages[0].text, /HSL sliders/);
    assert.match(client.postMessages[0].text, /\/p\/abc12345\//);
    assert.ok(traces.some((t) => t.event === "slack_ui.postPreview"));
  });
  await fs.unlink(filePath);
}

// Case 25: postPreview returns preview_host_not_configured when env is missing.
{
  _resetApprovalCounterForTests();
  await withPreviewEnv({ baseInternal: null, secret: null }, async () => {
    const client = makeFakeClient();
    const pendingApprovals = new Map();
    const traces = [];
    const ui = createSlackUIContext({
      client, channel: "C25", threadTs: "25.0",
      requestId: "req_pp25", pendingApprovals,
      trace: (event, data) => traces.push({ event, data }),
    });
    const result = await ui.postPreview("x", "/tmp/x.html");
    assert.equal(result.ok, false);
    assert.equal(result.error, "preview_host_not_configured");
    assert.equal(client.postMessages.length, 0, "no Slack message when not configured");
    assert.ok(traces.some((t) => t.event === "slack_ui.postPreview_not_configured"));
  });
}

// Case 26: postPreview surfaces a non-2xx response as preview_upload_status_*
// and does not post a Slack message.
{
  _resetApprovalCounterForTests();
  const fs = await import("node:fs/promises");
  const tmp = await import("node:os").then((m) => m.tmpdir());
  const filePath = `${tmp}/pi-postpreview-${Date.now()}-26.html`;
  await fs.writeFile(filePath, "<!doctype html><html><body>x</body></html>");

  await withPreviewEnv({}, async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      text: async () => "forbidden",
      json: async () => ({}),
    });
    const client = makeFakeClient();
    const pendingApprovals = new Map();
    const ui = createSlackUIContext({
      client, channel: "C26", threadTs: "26.0",
      requestId: "req_pp26", pendingApprovals,
    });
    const result = await ui.postPreview("x", filePath);
    assert.equal(result.ok, false);
    assert.match(result.error, /preview_upload_status_403/);
    assert.equal(client.postMessages.length, 0);
  });
  await fs.unlink(filePath);
}

// Case 27: postPreview surfaces a zip-build failure (missing index.html in a
// dir source) without contacting the preview host.
{
  _resetApprovalCounterForTests();
  const fs = await import("node:fs/promises");
  const tmp = await import("node:os").then((m) => m.tmpdir());
  const dir = `${tmp}/pi-postpreview-noidx-${Date.now()}`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${dir}/main.html`, "<html></html>");

  await withPreviewEnv({}, async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true }; };
    const client = makeFakeClient();
    const pendingApprovals = new Map();
    const ui = createSlackUIContext({
      client, channel: "C27", threadTs: "27.0",
      requestId: "req_pp27", pendingApprovals,
    });
    const result = await ui.postPreview("x", dir);
    assert.equal(result.ok, false);
    assert.match(result.error, /missing_index_html_in_source_dir/);
    assert.equal(fetchCalled, false, "no fetch when zip build fails");
    assert.equal(client.postMessages.length, 0);
  });
  await fs.rm(dir, { recursive: true });
}

// Case 28: postPreview returns ui_disposed after dispose().
{
  _resetApprovalCounterForTests();
  await withPreviewEnv({}, async () => {
    const client = makeFakeClient();
    const pendingApprovals = new Map();
    const ui = createSlackUIContext({
      client, channel: "C28", threadTs: "28.0",
      requestId: "req_pp28", pendingApprovals,
    });
    ui.dispose();
    const result = await ui.postPreview("x", "/tmp/x.html");
    assert.equal(result.ok, false);
    assert.equal(result.error, "ui_disposed");
  });
}

console.log("slack-ui-context tests passed");
