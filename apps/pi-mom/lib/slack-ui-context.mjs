// Translates Pi SDK ExtensionUIContext (extensions/types.d.ts:67) into Slack
// interactive surfaces. Used by Pi extensions that call ctx.ui.select /
// confirm / input from inside an agent loop.
//
// Why buttons-in-thread (and not `views.open`) for confirm/select:
//   `views.open` requires a `trigger_id` that's only valid for ~3 seconds and
//   only available right after a user-initiated Slack event. Pi tool callbacks
//   run asynchronously inside an agent loop — there is no live trigger_id, so
//   a modal cannot be opened at the moment of the prompt. The workable shape
//   is to post a blocks-with-buttons message immediately; clicks resolve the
//   pending promise via the action handlers wired in index.mjs. Modals are
//   only used for `input` (free text), where a "Provide input" launcher
//   button gives us a fresh trigger_id to open a modal with a real text
//   field.
//
// Lifecycle:
//   1. The factory is constructed per-turn in index.mjs.runPiWithSlackStream
//      with a shared `pendingApprovals` Map (key: approvalId).
//   2. Each call to confirm/select/input:
//      - allocates an approvalId,
//      - registers a pending entry holding {resolve, type, channel, threadTs,
//        messageTs, options, defaultValue, signal/timeout teardown} in the
//        Map before posting so a fast button click cannot race registration,
//      - posts a Slack message with the right blocks,
//      - fills messageTs after postMessage resolves,
//      - returns the awaitable promise.
//   3. Bolt action/view handlers (registered globally at app startup) look
//      up the entry by approvalId, edit the original message to show the
//      resolution, resolve the promise, and delete the entry.
//   4. opts.signal/opts.timeout (per ExtensionUIDialogOptions) resolve the
//      promise with the default ("No"/false/undefined) and tear down the
//      entry.
//   5. dispose() resolves every still-pending entry registered by this UI
//      context with the default — called when runTurn settles so a stuck
//      modal cannot wedge the next turn.

const DEFAULT_NOTIFY_ICONS = { info: "ℹ️", warning: "⚠️", error: "🛑" };
// pi-mcp-adapter calls ui.theme.fg/bg/bold etc. to style status-bar text.
// The headless Slack context has no terminal, so every method is a pass-through.
const NOOP_THEME = Object.freeze({
  name: "slack",
  fg: (_color, text) => String(text ?? ""),
  bg: (_color, text) => String(text ?? ""),
  bold: (text) => String(text ?? ""),
  italic: (text) => String(text ?? ""),
  underline: (text) => String(text ?? ""),
  inverse: (text) => String(text ?? ""),
  strikethrough: (text) => String(text ?? ""),
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => (str) => String(str ?? ""),
  getBashModeBorderColor: () => (str) => String(str ?? ""),
});

const NOT_CANVAS_BOUND_HINT =
  "Slack canvas is unavailable in this turn (no Slack channel context, or this is a non-Slack surface).";

let _approvalCounter = 0;
function nextApprovalId(requestId) {
  _approvalCounter += 1;
  return `appr_${requestId}_${_approvalCounter}_${Date.now().toString(36)}`;
}

export function _resetApprovalCounterForTests() {
  _approvalCounter = 0;
}

export function createSlackUIContext({
  client,
  channel,
  threadTs,
  requestId,
  pendingApprovals,
  surface,
  assistantSetStatus,
  trace = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  // Canvas plumbing — when provided, ctx.ui.startCanvas creates a Slack
  // canvas and attaches a canvas-sink to the live event fan so subsequent
  // text deltas mirror into the canvas. Without these the canvas methods
  // return an error result.
  compositeSink,
  createCanvasSinkFn,
  teamId,
  accessUserIds = [],
  redact,
  // Bridge introspection — bridgeHelp/bridgeStatus return canned strings
  // the model can post back to the user via bridge_help/bridge_status
  // tools. Plain string returners so the bridge can recompute live state
  // (uptime, auth) per call.
  bridgeHelp,
  bridgeStatus,
} = {}) {
  if (!client || typeof client.chat?.postMessage !== "function") {
    throw new Error("slack-ui-context: client.chat.postMessage is required");
  }
  if (!pendingApprovals || typeof pendingApprovals.set !== "function" || typeof pendingApprovals.get !== "function") {
    throw new Error("slack-ui-context: pendingApprovals Map is required");
  }
  if (!channel || !threadTs || !requestId) {
    throw new Error("slack-ui-context: channel, threadTs, and requestId are required");
  }

  const owned = new Set();
  let disposed = false;

  // Active canvas-sink (if any). startCanvas creates one and attaches it
  // to the compositeSink; stopCanvas detaches and finalizes. We only
  // support one live canvas per turn — the model can finish-and-start to
  // open another, but parallel canvases would race on the slack-sink
  // text-delta accumulator.
  let activeCanvasSink;
  const canCanvas = Boolean(
    compositeSink &&
      typeof compositeSink.addSink === "function" &&
      typeof compositeSink.removeSink === "function" &&
      typeof createCanvasSinkFn === "function" &&
      typeof client?.canvases?.create === "function",
  );

  function register(entry, opts = {}) {
    pendingApprovals.set(entry.approvalId, entry);
    owned.add(entry.approvalId);

    if (opts.signal) {
      if (opts.signal.aborted) {
        finalize(entry.approvalId, "aborted");
        return false;
      }
      entry.signal = opts.signal;
      entry.abortHandler = () => finalize(entry.approvalId, "aborted");
      opts.signal.addEventListener("abort", entry.abortHandler, { once: true });
    }

    if (opts.timeout && Number.isFinite(opts.timeout)) {
      entry.timeoutTimer = setTimeoutFn(() => finalize(entry.approvalId, "timeout"), opts.timeout);
    }
    return true;
  }

  function finalize(approvalId, reason) {
    const entry = pendingApprovals.get(approvalId);
    if (!entry) return;
    if (entry._finalized) return;
    entry._finalized = true;
    pendingApprovals.delete(approvalId);
    owned.delete(approvalId);
    if (entry.timeoutTimer !== undefined) {
      clearTimeoutFn(entry.timeoutTimer);
      entry.timeoutTimer = undefined;
    }
    if (entry.signal && entry.abortHandler) {
      try { entry.signal.removeEventListener("abort", entry.abortHandler); } catch {}
    }
    trace("slack_ui.finalized", {
      requestId,
      approvalId,
      reason,
      type: entry.type,
    });
    if (entry.messageTs) {
      const label = reason === "timeout" ? "timed out" : reason === "aborted" ? "aborted" : "expired";
      client.chat.update({
        channel: entry.channel,
        ts: entry.messageTs,
        text: `⌛ ${entry.title || "Approval"} — ${label}`,
        blocks: [],
      }).catch((err) => trace("slack_ui.finalize_message_update_failed", {
        approvalId,
        reason,
        error: err?.data?.error || err.message,
      }));
    }
    try { entry.resolve(entry.defaultValue); } catch {}
  }

  function postRegisteredInteractiveMessage({ entry, opts, postArgs, postedEvent, postedData = () => ({}), failedEvent }) {
    if (!register(entry, opts)) return;
    let postPromise;
    try {
      postPromise = client.chat.postMessage(postArgs);
    } catch (err) {
      trace(failedEvent, { requestId, approvalId: entry.approvalId, error: err?.data?.error || err.message });
      finalize(entry.approvalId, "post_failed");
      return;
    }
    Promise.resolve(postPromise).then((post) => {
      if (!entry._finalized) entry.messageTs = post.ts;
      trace(postedEvent, { requestId, approvalId: entry.approvalId, messageTs: post.ts, ...postedData(post) });
    }).catch((err) => {
      trace(failedEvent, { requestId, approvalId: entry.approvalId, error: err?.data?.error || err.message });
      finalize(entry.approvalId, "post_failed");
    });
  }

  async function confirm(title, message, opts = {}) {
    if (disposed) return false;
    const approvalId = nextApprovalId(requestId);
    return new Promise((resolve) => {
      const entry = {
        approvalId,
        type: "confirm",
        channel,
        threadTs,
        requestId,
        title: String(title || "Approval required"),
        message: String(message || ""),
        defaultValue: false,
        resolve,
      };

      const blocks = [
        { type: "header", text: { type: "plain_text", text: entry.title.slice(0, 150) || "Approval required", emoji: true } },
        { type: "section", text: { type: "mrkdwn", text: entry.message ? entry.message.slice(0, 2900) : "_(no detail)_" } },
        { type: "context", elements: [{ type: "mrkdwn", text: `req: \`${requestId}\` · approval: \`${approvalId}\`` }] },
        { type: "actions", elements: [
          { type: "button", action_id: "pi_uictx_confirm_approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: approvalId },
          { type: "button", action_id: "pi_uictx_confirm_cancel", style: "danger", text: { type: "plain_text", text: "Cancel" }, value: approvalId },
        ] },
      ];

      postRegisteredInteractiveMessage({
        entry,
        opts,
        postArgs: {
          channel,
          thread_ts: threadTs,
          text: `⚠️ Approval requested: ${entry.title}`,
          blocks,
        },
        postedEvent: "slack_ui.confirm_posted",
        failedEvent: "slack_ui.confirm_post_failed",
      });
    });
  }

  async function select(title, options, opts = {}) {
    if (disposed || !Array.isArray(options) || options.length === 0) return undefined;
    const approvalId = nextApprovalId(requestId);
    const opts_capped = options.slice(0, 5).map((opt) => String(opt));
    return new Promise((resolve) => {
      const entry = {
        approvalId,
        type: "select",
        channel,
        threadTs,
        requestId,
        title: String(title || "Choose an option"),
        options: opts_capped,
        defaultValue: undefined,
        resolve,
      };

      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: `*${entry.title.slice(0, 280)}*` } },
        { type: "context", elements: [{ type: "mrkdwn", text: `req: \`${requestId}\` · approval: \`${approvalId}\`` }] },
        { type: "actions", elements: opts_capped.map((opt, idx) => ({
          type: "button",
          action_id: `pi_uictx_select_${idx}`,
          text: { type: "plain_text", text: opt.slice(0, 75) },
          value: `${approvalId}:${idx}`,
          style: idx === 0 ? "primary" : undefined,
        })) },
      ];

      postRegisteredInteractiveMessage({
        entry,
        opts,
        postArgs: {
          channel,
          thread_ts: threadTs,
          text: `Select: ${entry.title}`,
          blocks,
        },
        postedEvent: "slack_ui.select_posted",
        postedData: () => ({ optionCount: opts_capped.length }),
        failedEvent: "slack_ui.select_post_failed",
      });
    });
  }

  // Richer block-kit variant of confirm: header + short summary + scrollable
  // preview body + approve/reject buttons. Reuses the existing
  // pi_uictx_confirm_approve / pi_uictx_confirm_cancel Bolt handlers via the
  // same pendingApprovals lifecycle as `confirm()`. Returned promise resolves
  // to true on approve, false on reject, false on signal/timeout/dispose.
  async function confirmWithPreview(title, summary, previewMd, opts = {}) {
    if (disposed) return false;
    const approvalId = nextApprovalId(requestId);
    const approveLabel = String(opts.approveLabel || "Approve").slice(0, 75) || "Approve";
    const rejectLabel = String(opts.rejectLabel || "Cancel").slice(0, 75) || "Cancel";
    return new Promise((resolve) => {
      const entry = {
        approvalId,
        type: "confirm",
        channel,
        threadTs,
        requestId,
        title: String(title || "Approval required"),
        message: String(summary || ""),
        defaultValue: false,
        resolve,
      };

      const headerText = entry.title.slice(0, 150) || "Approval required";
      const summaryText = entry.message ? entry.message.slice(0, 2900) : "_(no summary)_";
      const previewText = previewMd ? String(previewMd).slice(0, 2900) : "_(no preview)_";
      const blocks = [
        { type: "header", text: { type: "plain_text", text: headerText, emoji: true } },
        { type: "section", text: { type: "mrkdwn", text: summaryText } },
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: previewText } },
        { type: "context", elements: [{ type: "mrkdwn", text: `req: \`${requestId}\` · approval: \`${approvalId}\`` }] },
        { type: "actions", elements: [
          { type: "button", action_id: "pi_uictx_confirm_approve", style: "primary", text: { type: "plain_text", text: approveLabel }, value: approvalId },
          { type: "button", action_id: "pi_uictx_confirm_cancel", style: "danger", text: { type: "plain_text", text: rejectLabel }, value: approvalId },
        ] },
      ];

      postRegisteredInteractiveMessage({
        entry,
        opts,
        postArgs: {
          channel,
          thread_ts: threadTs,
          text: `⚠️ Approval requested: ${entry.title}`,
          blocks,
        },
        postedEvent: "slack_ui.confirm_with_preview_posted",
        failedEvent: "slack_ui.confirm_with_preview_post_failed",
      });
    });
  }

  // Richer block-kit variant of select: each option carries its own markdown
  // context block above the button. Returns the opaque `id` of the chosen
  // option (not the label) — the caller owns the namespace. Reuses the
  // existing pi_uictx_select_${idx} Bolt handler; the resolver branches on
  // entry.optionsRich to return id instead of label (see resolveSelectAction).
  async function selectWithContext(title, summary, options, opts = {}) {
    if (disposed || !Array.isArray(options) || options.length === 0) return undefined;
    const approvalId = nextApprovalId(requestId);
    const optionsRich = options.slice(0, 5).map((opt) => ({
      id: String(opt?.id ?? "").slice(0, 64),
      label: String(opt?.label ?? "").slice(0, 75),
      context_md: opt?.context_md ? String(opt.context_md).slice(0, 600) : "",
    }));
    return new Promise((resolve) => {
      const entry = {
        approvalId,
        type: "select",
        channel,
        threadTs,
        requestId,
        title: String(title || "Choose an option"),
        // Keep `options` for backward-compat consumers but the resolver
        // prefers `optionsRich` when present.
        options: optionsRich.map((o) => o.label),
        optionsRich,
        defaultValue: undefined,
        resolve,
      };

      const blocks = [
        { type: "header", text: { type: "plain_text", text: entry.title.slice(0, 150) || "Choose an option", emoji: true } },
      ];
      if (summary) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: String(summary).slice(0, 2900) } });
      }
      blocks.push({ type: "divider" });
      optionsRich.forEach((rich, idx) => {
        if (rich.context_md) {
          blocks.push({ type: "section", text: { type: "mrkdwn", text: rich.context_md } });
        }
        blocks.push({
          type: "actions",
          elements: [{
            type: "button",
            action_id: `pi_uictx_select_${idx}`,
            text: { type: "plain_text", text: rich.label || `Option ${idx + 1}` },
            value: `${approvalId}:${idx}`,
            style: idx === 0 ? "primary" : undefined,
          }],
        });
      });
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `req: \`${requestId}\` · approval: \`${approvalId}\`` }] });

      postRegisteredInteractiveMessage({
        entry,
        opts,
        postArgs: {
          channel,
          thread_ts: threadTs,
          text: `Select: ${entry.title}`,
          blocks,
        },
        postedEvent: "slack_ui.select_with_context_posted",
        postedData: () => ({ optionCount: optionsRich.length }),
        failedEvent: "slack_ui.select_with_context_post_failed",
      });
    });
  }

  // Richer variant of input: same launcher-button → modal flow as `input()`,
  // but the launcher message includes a markdown framing block above the
  // buttons so the agent can explain what it's asking for. Reuses
  // pi_uictx_input_launch / pi_uictx_input_skip / pi_uictx_input_modal
  // handlers; the modal itself is unchanged.
  async function inputRequest(title, prompt, opts = {}) {
    if (disposed) return undefined;
    const approvalId = nextApprovalId(requestId);
    return new Promise((resolve) => {
      const entry = {
        approvalId,
        type: "input",
        channel,
        threadTs,
        requestId,
        title: String(title || "Input required"),
        placeholder: opts.placeholder ? String(opts.placeholder) : "",
        multiline: opts.multiline !== false,
        defaultValue: undefined,
        resolve,
      };

      const promptText = prompt ? String(prompt).slice(0, 2900) : "";
      const blocks = [
        { type: "header", text: { type: "plain_text", text: entry.title.slice(0, 150) || "Input required", emoji: true } },
      ];
      if (promptText) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: promptText } });
      }
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `req: \`${requestId}\` · approval: \`${approvalId}\`` }] });
      blocks.push({ type: "actions", elements: [
        { type: "button", action_id: "pi_uictx_input_launch", style: "primary", text: { type: "plain_text", text: "Provide input" }, value: approvalId },
        { type: "button", action_id: "pi_uictx_input_skip", text: { type: "plain_text", text: "Skip" }, value: approvalId },
      ] });

      postRegisteredInteractiveMessage({
        entry,
        opts,
        postArgs: {
          channel,
          thread_ts: threadTs,
          text: `Input requested: ${entry.title}`,
          blocks,
        },
        postedEvent: "slack_ui.input_request_posted",
        failedEvent: "slack_ui.input_request_post_failed",
      });
    });
  }

  async function input(title, placeholder, opts = {}) {
    if (disposed) return undefined;
    const approvalId = nextApprovalId(requestId);
    return new Promise((resolve) => {
      const entry = {
        approvalId,
        type: "input",
        channel,
        threadTs,
        requestId,
        title: String(title || "Input required"),
        placeholder: placeholder ? String(placeholder) : "",
        defaultValue: undefined,
        resolve,
      };

      const blocks = [
        { type: "section", text: { type: "mrkdwn", text: `*${entry.title.slice(0, 280)}*${entry.placeholder ? `\n_${entry.placeholder.slice(0, 280)}_` : ""}` } },
        { type: "context", elements: [{ type: "mrkdwn", text: `req: \`${requestId}\` · approval: \`${approvalId}\`` }] },
        { type: "actions", elements: [
          { type: "button", action_id: "pi_uictx_input_launch", style: "primary", text: { type: "plain_text", text: "Provide input" }, value: approvalId },
          { type: "button", action_id: "pi_uictx_input_skip", text: { type: "plain_text", text: "Skip" }, value: approvalId },
        ] },
      ];

      postRegisteredInteractiveMessage({
        entry,
        opts,
        postArgs: {
          channel,
          thread_ts: threadTs,
          text: `Input requested: ${entry.title}`,
          blocks,
        },
        postedEvent: "slack_ui.input_posted",
        failedEvent: "slack_ui.input_post_failed",
      });
    });
  }

  function notify(message, type = "info") {
    if (disposed) return;
    const icon = DEFAULT_NOTIFY_ICONS[type] || DEFAULT_NOTIFY_ICONS.info;
    const safe = String(message || "").slice(0, 2900);
    client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `${icon} ${safe}`,
    }).catch((err) => trace("slack_ui.notify_failed", { requestId, error: err?.data?.error || err.message }));
    trace("slack_ui.notify", { requestId, type, messageLength: safe.length });
  }

  function setStatus(key, text) {
    if (disposed) return;
    if (surface === "assistant" && typeof assistantSetStatus === "function" && text) {
      Promise.resolve(assistantSetStatus(text)).catch(() => {});
    }
    trace("slack_ui.setStatus", { requestId, key, text: text || null });
  }

  async function startCanvas({ title, initialText, postLinkToThread = true } = {}) {
    if (disposed) return { ok: false, error: "ui_disposed" };
    if (!canCanvas) return { ok: false, error: "canvas_unavailable" };
    if (activeCanvasSink) return { ok: false, error: "canvas_already_open", canvasId: activeCanvasSink.canvasId, url: activeCanvasSink.url };
    const sink = createCanvasSinkFn({
      client,
      channel,
      title: String(title || "Covent Pi document"),
      requestId,
      teamId,
      accessUserIds,
      trace,
      redact,
    });
    let started;
    try {
      started = await sink.start(initialText ? { initialText } : undefined);
    } catch (err) {
      trace("slack_ui.canvas_start_failed", { requestId, error: err?.data?.error || err?.message || "unknown" });
      return { ok: false, error: "canvas_start_failed" };
    }
    if (!started?.canvasId) return { ok: false, error: "canvas_create_failed" };
    activeCanvasSink = sink;
    compositeSink.addSink(sink);
    trace("slack_ui.canvas_started", { requestId, canvasId: started.canvasId, hasUrl: Boolean(started.url) });
    if (postLinkToThread && started.url) {
      try {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `📄 Streaming into a canvas → <${started.url}|${String(title || "document")}>`,
        });
      } catch (err) {
        trace("slack_ui.canvas_link_post_failed", { requestId, error: err?.data?.error || err?.message });
      }
    }
    return { ok: true, canvasId: started.canvasId, url: started.url };
  }

  async function stopCanvas({ finalMarkdown } = {}) {
    if (!activeCanvasSink) return { ok: false, error: "no_active_canvas" };
    const sink = activeCanvasSink;
    activeCanvasSink = undefined;
    try { compositeSink.removeSink(sink); } catch {}
    let stopResult;
    try {
      stopResult = await sink.stop({ result: typeof finalMarkdown === "string" ? finalMarkdown : undefined });
    } catch (err) {
      trace("slack_ui.canvas_stop_failed", { requestId, error: err?.data?.error || err?.message || "unknown" });
      return { ok: false, error: "canvas_stop_failed", canvasId: sink.canvasId, url: sink.url };
    }
    trace("slack_ui.canvas_stopped", { requestId, canvasId: stopResult?.canvasId, streamedChars: stopResult?.streamedChars });
    return { ok: true, canvasId: stopResult?.canvasId || sink.canvasId, url: stopResult?.url || sink.url, streamedChars: stopResult?.streamedChars || 0 };
  }

  async function getBridgeHelp() {
    if (typeof bridgeHelp === "function") {
      try { return String((await bridgeHelp()) || ""); } catch (err) { return `bridge_help unavailable: ${err?.message || "unknown"}`; }
    }
    return "Bridge help is not configured.";
  }

  async function getBridgeStatus() {
    if (typeof bridgeStatus === "function") {
      try { return String((await bridgeStatus()) || ""); } catch (err) { return `bridge_status unavailable: ${err?.message || "unknown"}`; }
    }
    return "Bridge status is not configured.";
  }

  function dispose(reason = "dispose") {
    if (disposed) return;
    disposed = true;
    for (const approvalId of [...owned]) finalize(approvalId, reason);
    // If the agent opened a canvas but never closed it, detach and
    // finalize so the canvas-sink's final replace lands. Best-effort.
    if (activeCanvasSink) {
      const sink = activeCanvasSink;
      activeCanvasSink = undefined;
      try { compositeSink?.removeSink?.(sink); } catch {}
      Promise.resolve(sink.stop({})).catch(() => {});
    }
  }

  return {
    select,
    confirm,
    input,
    confirmWithPreview,
    selectWithContext,
    inputRequest,
    notify,
    setStatus,
    startCanvas,
    stopCanvas,
    bridgeHelp: getBridgeHelp,
    bridgeStatus: getBridgeStatus,
    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: NOOP_THEME,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Slack UI context does not support themes" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
    dispose,
    get _ownedApprovalIds() { return [...owned]; },
  };
}

export function resolveSelectAction({ pendingApprovals, action, body, client, trace = () => {} }) {
  return _resolvePendingFromButton({
    pendingApprovals,
    body,
    client,
    trace,
    parse: () => {
      const [approvalId, idxStr] = String(action.value || "").split(":");
      const idx = Number(idxStr);
      return { approvalId, idx };
    },
    apply: (entry, parsed) => {
      // selectWithContext: resolve to the option's opaque id, but show the
      // human-readable label in the outcome message edit.
      if (Array.isArray(entry.optionsRich)) {
        const rich = entry.optionsRich[parsed.idx];
        if (!rich) return null;
        return {
          resolution: rich.id,
          outcomeText: `✅ ${entry.title} → ${rich.label || rich.id}`,
        };
      }
      const option = entry.options?.[parsed.idx];
      if (option === undefined) return null;
      return {
        resolution: option,
        outcomeText: `✅ ${entry.title} → ${option}`,
      };
    },
    label: "select",
  });
}

export function resolveConfirmAction({ pendingApprovals, action, body, client, trace = () => {} }) {
  return _resolvePendingFromButton({
    pendingApprovals,
    body,
    client,
    trace,
    parse: () => ({
      approvalId: String(action.value || ""),
      approved: action.action_id === "pi_uictx_confirm_approve",
    }),
    apply: (entry, parsed) => ({
      resolution: parsed.approved,
      outcomeText: `${parsed.approved ? "✅" : "❌"} ${entry.title} — ${parsed.approved ? "approved" : "canceled"}${body?.user?.id ? ` by <@${body.user.id}>` : ""}`,
    }),
    label: "confirm",
  });
}

export function resolveInputSubmission({ pendingApprovals, view, body, client, trace = () => {} }) {
  const approvalId = view?.private_metadata;
  const entry = pendingApprovals.get(approvalId);
  if (!entry || entry._finalized) return false;
  const value = view?.state?.values?.pi_uictx_input_block?.pi_uictx_input_value?.value || "";
  entry._finalized = true;
  pendingApprovals.delete(approvalId);
  if (entry.timeoutTimer !== undefined) clearTimeout(entry.timeoutTimer);
  if (entry.signal && entry.abortHandler) {
    try { entry.signal.removeEventListener("abort", entry.abortHandler); } catch {}
  }
  trace("slack_ui.input_submitted", { approvalId, requestId: entry.requestId, length: value.length });
  const messageTs = entry.messageTs || slackMessageTsFromBody(body);
  if (messageTs) {
    client.chat.update({
      channel: entry.channel,
      ts: messageTs,
      text: `✅ ${entry.title} — input received${body?.user?.id ? ` from <@${body.user.id}>` : ""}`,
      blocks: [],
    }).catch((err) => trace("slack_ui.input_message_update_failed", { approvalId, error: err?.data?.error || err.message }));
  }
  try { entry.resolve(value); } catch {}
  return true;
}

export function resolveInputCancel({ pendingApprovals, view, body, client, trace = () => {} }) {
  const approvalId = view?.private_metadata;
  const entry = pendingApprovals.get(approvalId);
  if (!entry || entry._finalized) return false;
  entry._finalized = true;
  pendingApprovals.delete(approvalId);
  if (entry.timeoutTimer !== undefined) clearTimeout(entry.timeoutTimer);
  if (entry.signal && entry.abortHandler) {
    try { entry.signal.removeEventListener("abort", entry.abortHandler); } catch {}
  }
  trace("slack_ui.input_canceled", { approvalId, requestId: entry.requestId });
  const messageTs = entry.messageTs || slackMessageTsFromBody(body);
  if (messageTs) {
    client.chat.update({
      channel: entry.channel,
      ts: messageTs,
      text: `❌ ${entry.title} — input canceled${body?.user?.id ? ` by <@${body.user.id}>` : ""}`,
      blocks: [],
    }).catch((err) => trace("slack_ui.input_message_update_failed", { approvalId, error: err?.data?.error || err.message }));
  }
  try { entry.resolve(undefined); } catch {}
  return true;
}

export function buildInputModalView({ approvalId, title, placeholder }) {
  return {
    type: "modal",
    callback_id: "pi_uictx_input_modal",
    private_metadata: approvalId,
    notify_on_close: true,
    title: { type: "plain_text", text: String(title || "Input required").slice(0, 24) },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "pi_uictx_input_block",
        element: {
          type: "plain_text_input",
          action_id: "pi_uictx_input_value",
          multiline: true,
          placeholder: placeholder ? { type: "plain_text", text: String(placeholder).slice(0, 150) } : undefined,
        },
        label: { type: "plain_text", text: String(title || "Input").slice(0, 75) },
      },
    ],
  };
}

function slackMessageTsFromBody(body) {
  return body?.message?.ts || body?.container?.message_ts;
}

function _resolvePendingFromButton({ pendingApprovals, body, client, trace, parse, apply, label }) {
  const parsed = parse();
  if (!parsed?.approvalId) {
    trace(`slack_ui.${label}_action_unparsable`, { value: parsed });
    return false;
  }
  const entry = pendingApprovals.get(parsed.approvalId);
  if (!entry) {
    trace(`slack_ui.${label}_action_unknown_approval`, { approvalId: parsed.approvalId });
    return false;
  }
  if (entry._finalized) return false;
  const applied = apply(entry, parsed);
  if (!applied) {
    trace(`slack_ui.${label}_action_invalid`, { approvalId: parsed.approvalId, parsed });
    return false;
  }
  entry._finalized = true;
  pendingApprovals.delete(parsed.approvalId);
  if (entry.timeoutTimer !== undefined) clearTimeout(entry.timeoutTimer);
  if (entry.signal && entry.abortHandler) {
    try { entry.signal.removeEventListener("abort", entry.abortHandler); } catch {}
  }
  trace(`slack_ui.${label}_resolved`, { approvalId: parsed.approvalId, requestId: entry.requestId });
  const messageTs = entry.messageTs || slackMessageTsFromBody(body);
  if (messageTs) {
    client.chat.update({
      channel: entry.channel,
      ts: messageTs,
      text: applied.outcomeText,
      blocks: [],
    }).catch((err) => trace(`slack_ui.${label}_message_update_failed`, { approvalId: parsed.approvalId, error: err?.data?.error || err.message }));
  }
  try { entry.resolve(applied.resolution); } catch {}
  return true;
}
