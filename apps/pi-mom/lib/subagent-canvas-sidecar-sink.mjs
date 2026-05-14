import { redactSensitiveText } from "./redaction.mjs";

const DEFAULT_FLUSH_MS = 3000;
const DEFAULT_FLUSH_BYTES = 1500;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 2000;
const TASK_PREVIEW_CHARS = 2000;
const FINAL_OUTPUT_CHARS = 6000;
const INLINE_CHARS = 300;
const LIFECYCLE_LINE_CHARS = 220;
const MAX_LIFECYCLE_LINES = 80;
const MAX_TARGETS = 50;
const MAX_CANVAS_TITLE_CHARS = 80;

export function defaultRedact(text = "") {
  return redactSensitiveText(text);
}

function asString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text = "", max = 1000) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 80))}\n\n…truncated by pi-mom for Slack Canvas safety (${s.length} chars total).`;
}

function sanitizeInline(value, { redact, max = INLINE_CHARS } = {}) {
  const redacted = (redact || defaultRedact)(asString(value));
  return truncate(redacted.replace(/\s+/g, " ").trim(), max) || "";
}

function sanitizeBlock(value, { redact, max } = {}) {
  const redacted = (redact || defaultRedact)(asString(value));
  return truncate(redacted.trim(), max);
}

function escapeSlackLinkText(text = "") {
  return String(text || "")
    .replace(/[<>]/g, "")
    .replace(/\|/g, "¦")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatSubagentCanvasFooter(canvases = []) {
  const lines = (Array.isArray(canvases) ? canvases : [])
    .filter((entry) => entry?.url)
    .map((entry) => {
      const label = escapeSlackLinkText(`${entry.title || entry.agent || "subagent"} — ${entry.status || "unknown"}`);
      return `• <${entry.url}|${label}>`;
    });
  if (lines.length === 0) return "";
  return `\n\n---\n*Subagent canvases*\n${lines.join("\n")}\n`;
}

function normalizeToolCallId(evt = {}) {
  return asString(
    evt.toolCallId ||
    evt.toolCall?.toolCallId ||
    evt.toolCall?.id ||
    evt.id ||
    "subagent_tool_call",
  );
}

function normalizeToolName(evt = {}) {
  return asString(evt.toolName || evt.toolCall?.toolName || evt.toolCall?.name || evt.name);
}

function normalizeArgs(evt = {}) {
  return evt.args ?? evt.toolCall?.args ?? evt.toolCall?.arguments ?? evt.toolCall?.input ?? {};
}

function normalizeSubagentEvent(evt = {}) {
  if (!evt || typeof evt !== "object") return undefined;
  if (!["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(evt.type)) return undefined;
  if (normalizeToolName(evt) !== "subagent") return undefined;
  return {
    type: evt.type,
    toolCallId: normalizeToolCallId(evt),
    args: normalizeArgs(evt),
    partialResult: evt.partialResult ?? evt.toolCall?.partialResult,
    result: evt.result ?? evt.toolCall?.result,
    isError: Boolean(evt.isError ?? evt.error ?? evt.toolCall?.isError ?? evt.toolCall?.error),
  };
}

function extractDetails(payload) {
  if (!payload || typeof payload !== "object") return {};
  if (payload.details && typeof payload.details === "object") return payload.details;
  if (payload.result?.details && typeof payload.result.details === "object") return payload.result.details;
  return {};
}

function extractContentText(payload) {
  const content = payload?.content ?? payload?.result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function hasOwnObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeIndex(entry, fallback) {
  const n = Number(entry?.index);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function inferAgentFromArgs(args = {}, index = 0) {
  if (typeof args.agent === "string" && args.agent.trim()) return args.agent.trim();
  if (Array.isArray(args.tasks) && args.tasks[index]?.agent) return asString(args.tasks[index].agent);
  if (Array.isArray(args.chain)) {
    const flattened = [];
    for (const step of args.chain) {
      if (Array.isArray(step?.parallel)) {
        for (const parallel of step.parallel) flattened.push(parallel);
      } else {
        flattened.push(step);
      }
    }
    if (flattened[index]?.agent) return asString(flattened[index].agent);
  }
  return "subagent";
}

function inferTaskFromArgs(args = {}, index = 0) {
  if (typeof args.task === "string" && args.task.trim()) return args.task.trim();
  if (Array.isArray(args.tasks) && typeof args.tasks[index]?.task === "string") return args.tasks[index].task;
  if (Array.isArray(args.chain)) {
    const flattened = [];
    for (const step of args.chain) {
      if (Array.isArray(step?.parallel)) {
        for (const parallel of step.parallel) flattened.push(parallel);
      } else {
        flattened.push(step);
      }
    }
    if (typeof flattened[index]?.task === "string") return flattened[index].task;
  }
  return "";
}

function collectChildEntries(details = {}, args = {}) {
  const byKey = new Map();

  function getEntry(index, agent) {
    const key = `${index}:${agent || "subagent"}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { index, agent: agent || inferAgentFromArgs(args, index) };
      byKey.set(key, entry);
    }
    return entry;
  }

  const results = Array.isArray(details.results) ? details.results : [];
  results.forEach((result, fallbackIndex) => {
    if (!hasOwnObject(result)) return;
    const index = normalizeIndex(result.progress || result, fallbackIndex);
    const agent = asString(result.agent || result.progress?.agent || inferAgentFromArgs(args, index)) || "subagent";
    const entry = getEntry(index, agent);
    entry.result = result;
    if (hasOwnObject(result.progress)) entry.progress = result.progress;
  });

  const progress = Array.isArray(details.progress) ? details.progress : [];
  progress.forEach((prog, fallbackIndex) => {
    if (!hasOwnObject(prog)) return;
    const index = normalizeIndex(prog, fallbackIndex);
    const agent = asString(prog.agent || inferAgentFromArgs(args, index)) || "subagent";
    const entry = getEntry(index, agent);
    entry.progress = prog;
  });

  return Array.from(byKey.values()).sort((a, b) => a.index - b.index || a.agent.localeCompare(b.agent));
}

function statusFromResult(result, isFinal = false, isError = false) {
  if (!result && !isFinal) return undefined;
  if (result?.detached) return "detached";
  if (isError || result?.isError || result?.error || (Number.isFinite(result?.exitCode) && result.exitCode !== 0)) return "failed";
  if (isFinal || Number.isFinite(result?.exitCode)) return "completed";
  return undefined;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function summarizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const input = firstNumber(usage.input, usage.inputTokens);
  const output = firstNumber(usage.output, usage.outputTokens);
  const turns = firstNumber(usage.turns, usage.turnCount);
  const tokens = firstNumber(usage.tokens, (input || 0) + (output || 0));
  return { input, output, turns, tokens };
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${Math.round(n / 100) / 10}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatStats({ status, toolCount, durationMs, tokens, error }) {
  const pieces = [];
  if (Number.isFinite(toolCount)) pieces.push(`${toolCount} tools`);
  const duration = formatDuration(durationMs);
  if (duration) pieces.push(duration);
  if (Number.isFinite(tokens) && tokens > 0) pieces.push(`${tokens} tokens`);
  const suffix = pieces.length ? `: ${pieces.join(", ")}` : "";
  const err = error ? ` (${truncate(String(error), 160).replace(/\s+/g, " ")})` : "";
  return `${status || "completed"}${suffix}${err}`;
}

function parseJsonMaybe(text) {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function collectPathLikes(value, out = new Set()) {
  if (out.size >= MAX_TARGETS || value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectPathLikes(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/path|file|target|cwd|dir/i.test(key) && typeof child === "string") collectPathLikes(child, out);
      else collectPathLikes(child, out);
    }
    return out;
  }
  const text = String(value);
  if (!text || text.length > 2000) return out;

  const pathPattern = /(?:^|[\s"'`(])((?:\.{1,2}\/|~\/)?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+:-]+)(?=$|[\s"'`,)\]])/g;
  let match;
  while ((match = pathPattern.exec(text)) && out.size < MAX_TARGETS) {
    const candidate = match[1];
    if (!candidate || /^https?:\/\//i.test(candidate)) continue;
    out.add(candidate);
  }
  return out;
}

function toolArgsPreview(tool, args, { redact } = {}) {
  const parsed = typeof args === "string" ? parseJsonMaybe(args) : undefined;
  const targets = Array.from(collectPathLikes(parsed ?? args));
  const target = targets[0];
  if (target) return sanitizeInline(target, { redact, max: 160 });
  const raw = sanitizeInline(args, { redact, max: 160 });
  if (!raw || raw === "{}") return "";
  return raw;
}

function addLifecycle(child, line, { redact } = {}) {
  const safe = sanitizeInline(line, { redact, max: LIFECYCLE_LINE_CHARS });
  if (!safe) return;
  if (child.lifecycle.includes(safe)) return;
  child.lifecycle.push(safe);
  if (child.lifecycle.length > MAX_LIFECYCLE_LINES) {
    const first = child.lifecycle[0] === "started" ? [child.lifecycle[0]] : [];
    child.lifecycle = [...first, ...child.lifecycle.slice(-(MAX_LIFECYCLE_LINES - first.length))];
  }
}

function mergeTargets(child, value, { redact } = {}) {
  for (const target of collectPathLikes(value)) {
    if (child.targets.size >= MAX_TARGETS) break;
    const safe = sanitizeInline(target, { redact, max: 260 });
    if (safe) child.targets.add(safe);
  }
}

function mergeToolActivity(child, progress, result, { redact } = {}) {
  if (progress?.currentPath) mergeTargets(child, progress.currentPath, { redact });
  if (progress?.currentTool) {
    mergeTargets(child, progress.currentToolArgs, { redact });
    const preview = toolArgsPreview(progress.currentTool, progress.currentToolArgs, { redact });
    addLifecycle(child, `tool ${progress.currentTool}${preview ? ` ${preview}` : ""}`, { redact });
  }
  if (Array.isArray(progress?.recentTools)) {
    for (const toolEntry of progress.recentTools) {
      if (!toolEntry?.tool) continue;
      mergeTargets(child, toolEntry.args, { redact });
      const preview = toolArgsPreview(toolEntry.tool, toolEntry.args, { redact });
      addLifecycle(child, `tool ${toolEntry.tool}${preview ? ` ${preview}` : ""}`, { redact });
    }
  }
  if (Array.isArray(result?.toolCalls)) {
    for (const call of result.toolCalls) {
      const text = call?.text || call?.expandedText;
      if (!text) continue;
      mergeTargets(child, text, { redact });
      addLifecycle(child, `tool ${text}`, { redact });
    }
  }
}

function buildTitle(agent, index) {
  const prefix = sanitizeInline(agent || "subagent", { redact: defaultRedact, max: 48 }) || "subagent";
  return `Subagent ${index + 1}: ${prefix}`.slice(0, MAX_CANVAS_TITLE_CHARS);
}

function terminalStatus(status) {
  return ["completed", "failed", "detached"].includes(status);
}

function renderChildMarkdown(child, { requestId, redact } = {}) {
  const lines = [];
  const agent = sanitizeInline(child.agent || "subagent", { redact, max: 120 }) || "subagent";
  lines.push(`# Subagent: ${agent}`);
  lines.push("");
  const meta = [
    ["Request", requestId],
    ["Parent tool call", child.toolCallId],
    ["CWD", child.cwd],
    ["Status", child.status || "running"],
    ["Model", child.model],
  ];
  for (const [label, value] of meta) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`- ${label}: ${sanitizeInline(value, { redact })}`);
  }
  lines.push("");
  lines.push("## Task");
  lines.push(sanitizeBlock(child.task || "(not provided)", { redact, max: TASK_PREVIEW_CHARS }) || "(not provided)");
  lines.push("");
  lines.push("## Lifecycle");
  if (child.lifecycle.length === 0) lines.push("- started");
  else for (const entry of child.lifecycle) lines.push(`- ${sanitizeInline(entry, { redact, max: LIFECYCLE_LINE_CHARS })}`);
  lines.push("");
  lines.push("## Tool targets observed");
  const targets = Array.from(child.targets).slice(0, MAX_TARGETS);
  if (targets.length === 0) lines.push("- (none)");
  else for (const target of targets) lines.push(`- ${sanitizeInline(target, { redact, max: 260 })}`);
  lines.push("");
  lines.push("## Final output");
  const finalText = child.finalOutput || child.error || (terminalStatus(child.status) ? "(no final output captured)" : "_Still running…_");
  lines.push(sanitizeBlock(finalText, { redact, max: FINAL_OUTPUT_CHARS }) || "(empty)");
  lines.push("");
  return lines.join("\n");
}

function isRateLimitError(err) {
  const code = err?.data?.error || err?.code || err?.message;
  return code === "ratelimited" || code === "rate_limited";
}

export function createSubagentCanvasSidecarSink({
  client,
  channel,
  threadTs,
  requestId,
  teamId,
  accessUserIds = [],
  trace = () => {},
  redact = defaultRedact,
  flushMs = DEFAULT_FLUSH_MS,
  flushBytes = DEFAULT_FLUSH_BYTES,
  rateLimitBackoffMs = DEFAULT_RATE_LIMIT_BACKOFF_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => Date.now(),
} = {}) {
  const canUseCanvas = typeof client?.canvases?.create === "function" && typeof client?.canvases?.edit === "function";
  const parents = new Map();
  const children = new Map();
  let started = false;
  let stopped = false;
  let queue = Promise.resolve();
  let createDisabledTraced = false;

  function traceSoft(event, data = {}) {
    try { trace(event, { requestId, ...data }); } catch {}
  }

  function enqueue(fn) {
    queue = queue.then(fn).catch((err) => {
      traceSoft("subagent_canvas.queue_error", { error: err?.data?.error || err?.message || String(err) });
    });
    return queue;
  }

  function getParent(toolCallId, args = {}) {
    let parent = parents.get(toolCallId);
    if (!parent) {
      parent = {
        toolCallId,
        args: args && typeof args === "object" ? args : {},
        startedAt: now(),
      };
      parents.set(toolCallId, parent);
    } else if (args && typeof args === "object") {
      parent.args = { ...parent.args, ...args };
    }
    return parent;
  }

  function fallbackChildKey(toolCallId, index, agent) {
    return `${toolCallId}:${index}:${agent || "subagent"}`;
  }

  function primaryChildKey(parent, details, index, agent) {
    return details?.runId
      ? `${details.runId}:${index}:${agent || "subagent"}`
      : fallbackChildKey(parent.toolCallId, index, agent);
  }

  function getChild(parent, details, entry) {
    const index = Number.isInteger(entry.index) ? entry.index : 0;
    const agent = entry.agent || inferAgentFromArgs(parent.args, index);
    const primaryKey = primaryChildKey(parent, details, index, agent);
    const fallbackKey = fallbackChildKey(parent.toolCallId, index, agent);
    let child = children.get(primaryKey) || children.get(fallbackKey);
    if (child && primaryKey !== fallbackKey && children.get(fallbackKey) === child) {
      children.delete(fallbackKey);
      children.set(primaryKey, child);
    }
    if (!child) {
      child = {
        key: primaryKey,
        order: children.size,
        toolCallId: parent.toolCallId,
        index,
        agent,
        status: "running",
        task: inferTaskFromArgs(parent.args, index),
        cwd: parent.args?.cwd,
        model: parent.args?.model,
        lifecycle: ["started"],
        targets: new Set(),
        createdAt: now(),
        fullMarkdown: "",
        lastFlushedMarkdown: "",
        dirty: false,
        disabled: false,
        createAttempted: false,
        createPromise: null,
        busy: false,
        flushTimer: undefined,
        title: buildTitle(agent, index),
      };
      children.set(primaryKey, child);
    }
    child.key = primaryKey;
    child.agent = agent || child.agent;
    child.index = index;
    return child;
  }

  async function grantAccess(child) {
    if (!child.canvasId || typeof client?.canvases?.access?.set !== "function") return;
    if (Array.isArray(accessUserIds) && accessUserIds.length > 0) {
      try {
        await client.canvases.access.set({
          canvas_id: child.canvasId,
          user_ids: accessUserIds,
          access_level: "write",
        });
        traceSoft("subagent_canvas.access_granted", { canvasId: child.canvasId, userCount: accessUserIds.length });
      } catch (err) {
        traceSoft("subagent_canvas.access_set_failed", { canvasId: child.canvasId, error: err?.data?.error || err?.message || "unknown" });
      }
    }
    if (channel) {
      try {
        await client.canvases.access.set({
          canvas_id: child.canvasId,
          channel_ids: [channel],
          access_level: "read",
        });
        traceSoft("subagent_canvas.channel_access_granted", { canvasId: child.canvasId, channel, accessLevel: "read" });
      } catch (err) {
        traceSoft("subagent_canvas.channel_access_failed", { canvasId: child.canvasId, error: err?.data?.error || err?.message || "unknown" });
      }
    }
  }

  async function ensureCanvas(child) {
    if (child.canvasId || child.disabled) return child.canvasId;
    if (!canUseCanvas) {
      child.disabled = true;
      if (!createDisabledTraced) {
        createDisabledTraced = true;
        traceSoft("subagent_canvas.unavailable", { reason: "missing_canvas_methods" });
      }
      return undefined;
    }
    if (child.createPromise) return child.createPromise;
    child.createAttempted = true;
    child.createPromise = (async () => {
      try {
        const initialMarkdown = child.fullMarkdown || renderChildMarkdown(child, { requestId, redact });
        const resp = await client.canvases.create({
          title: child.title,
          document_content: { type: "markdown", markdown: initialMarkdown },
        });
        child.canvasId = resp?.canvas_id || resp?.canvas?.id;
        child.url = resp?.canvas?.url || resp?.canvas_url || (
          child.canvasId && teamId ? `https://app.slack.com/docs/${teamId}/${child.canvasId}` : undefined
        );
        child.lastFlushedMarkdown = initialMarkdown;
        child.dirty = false;
        traceSoft("subagent_canvas.created", {
          canvasId: child.canvasId,
          agent: child.agent,
          index: child.index,
          hasUrl: Boolean(child.url),
          hasTeamId: Boolean(teamId),
        });
        await grantAccess(child);
        return child.canvasId;
      } catch (err) {
        child.disabled = true;
        traceSoft("subagent_canvas.create_failed", {
          agent: child.agent,
          index: child.index,
          error: err?.data?.error || err?.message || "unknown",
        });
        return undefined;
      } finally {
        child.createPromise = null;
      }
    })();
    return child.createPromise;
  }

  async function flushChild(child, { final = false } = {}) {
    if (!child || child.busy) return;
    if (child.flushTimer !== undefined) {
      clearTimeoutFn(child.flushTimer);
      child.flushTimer = undefined;
    }
    const markdown = child.fullMarkdown || renderChildMarkdown(child, { requestId, redact });
    if (!final && (!child.dirty || markdown === child.lastFlushedMarkdown)) {
      child.dirty = false;
      return;
    }
    child.busy = true;
    try {
      await ensureCanvas(child);
      if (!child.canvasId || child.disabled) return;
      if (markdown === child.lastFlushedMarkdown) {
        child.dirty = false;
        return;
      }
      await client.canvases.edit({
        canvas_id: child.canvasId,
        changes: [{
          operation: "replace",
          document_content: { type: "markdown", markdown },
        }],
      });
      child.lastFlushedMarkdown = markdown;
      child.dirty = false;
      traceSoft("subagent_canvas.replaced", {
        canvasId: child.canvasId,
        agent: child.agent,
        index: child.index,
        bytes: markdown.length,
        final,
      });
    } catch (err) {
      child.dirty = true;
      if (isRateLimitError(err) && !stopped) {
        traceSoft("subagent_canvas.rate_limited", { canvasId: child.canvasId, retryAfterMs: rateLimitBackoffMs });
        child.flushTimer = setTimeoutFn(() => {
          child.flushTimer = undefined;
          enqueue(() => flushChild(child));
        }, rateLimitBackoffMs);
      } else {
        traceSoft("subagent_canvas.replace_failed", {
          canvasId: child.canvasId,
          agent: child.agent,
          index: child.index,
          error: err?.data?.error || err?.message || "unknown",
        });
      }
    } finally {
      child.busy = false;
    }
  }

  function scheduleFlush(child) {
    if (!child || child.disabled) return;
    const delta = Math.abs((child.fullMarkdown || "").length - (child.lastFlushedMarkdown || "").length);
    if (delta >= flushBytes) {
      if (child.flushTimer !== undefined) {
        clearTimeoutFn(child.flushTimer);
        child.flushTimer = undefined;
      }
      enqueue(() => flushChild(child));
      return;
    }
    if (child.flushTimer !== undefined || stopped) return;
    child.flushTimer = setTimeoutFn(() => {
      child.flushTimer = undefined;
      enqueue(() => flushChild(child));
    }, flushMs);
  }

  function mergeChildState(child, parent, details, payload, entry, { isFinal, isError } = {}) {
    const progress = entry.progress;
    const result = entry.result;
    child.runId = details?.runId || child.runId;
    child.mode = details?.mode || child.mode;
    child.context = details?.context || child.context;
    child.cwd = parent.args?.cwd || details?.cwd || result?.cwd || child.cwd;
    child.task = progress?.task || result?.task || child.task || inferTaskFromArgs(parent.args, child.index);
    child.model = result?.model || progress?.model || parent.args?.model || child.model;
    child.skills = result?.skills || progress?.skills || child.skills;
    child.skillsWarning = result?.skillsWarning || child.skillsWarning;

    const usage = summarizeUsage(result?.usage);
    child.toolCount = firstNumber(progress?.toolCount, result?.progressSummary?.toolCount, result?.progress?.toolCount, details?.progressSummary?.toolCount, child.toolCount);
    child.tokens = firstNumber(progress?.tokens, result?.progressSummary?.tokens, result?.progress?.tokens, details?.progressSummary?.tokens, usage?.tokens, child.tokens);
    child.durationMs = firstNumber(progress?.durationMs, result?.progressSummary?.durationMs, result?.progress?.durationMs, details?.progressSummary?.durationMs, child.durationMs);

    const nextStatus = progress?.status || statusFromResult(result, isFinal, isError);
    if (nextStatus) child.status = nextStatus;
    if (isFinal && !terminalStatus(child.status)) child.status = isError ? "failed" : "completed";

    child.error = result?.error || progress?.error || (isError ? extractContentText(payload) : "") || child.error;
    if (typeof result?.finalOutput === "string" && result.finalOutput.trim()) {
      child.finalOutput = result.finalOutput;
    } else if (child.status === "failed" && child.error) {
      child.finalOutput = child.error;
    }

    mergeToolActivity(child, progress, result, { redact });

    if (terminalStatus(child.status)) {
      addLifecycle(child, formatStats({
        status: child.status,
        toolCount: child.toolCount,
        durationMs: child.durationMs,
        tokens: child.tokens,
        error: child.status === "failed" ? child.error : undefined,
      }), { redact });
    }

    child.fullMarkdown = renderChildMarkdown(child, { requestId, redact });
    child.dirty = child.fullMarkdown !== child.lastFlushedMarkdown;
  }

  async function processPayload(parent, payload, { isFinal = false, isError = false } = {}) {
    const details = extractDetails(payload);
    const entries = collectChildEntries(details, parent.args);
    if (entries.length === 0) return;

    for (const entry of entries) {
      const child = getChild(parent, details, entry);
      mergeChildState(child, parent, details, payload, entry, { isFinal, isError });
      await ensureCanvas(child);
      if (isFinal || terminalStatus(child.status)) await flushChild(child, { final: isFinal });
      else scheduleFlush(child);
    }
  }

  function start() {
    started = true;
  }

  function handle(evt) {
    if (stopped) return;
    const normalized = normalizeSubagentEvent(evt);
    if (!normalized) return;
    const parent = getParent(normalized.toolCallId, normalized.args);
    if (normalized.type === "tool_execution_start") {
      parent.startedAt = parent.startedAt || now();
      return;
    }
    enqueue(async () => {
      if (normalized.type === "tool_execution_update") {
        await processPayload(parent, normalized.partialResult, { isFinal: false, isError: false });
      } else if (normalized.type === "tool_execution_end") {
        parent.endedAt = now();
        parent.isError = normalized.isError;
        await processPayload(parent, normalized.result, { isFinal: true, isError: normalized.isError });
      }
    });
  }

  function metadata() {
    return Array.from(children.values())
      .filter((child) => child.canvasId || child.url)
      .sort((a, b) => a.order - b.order)
      .map((child) => ({
        agent: child.agent,
        index: child.index,
        status: child.status || "unknown",
        canvasId: child.canvasId,
        url: child.url,
        title: child.title,
      }));
  }

  async function stop({ result, error } = {}) {
    stopped = true;
    await queue;
    for (const child of children.values()) {
      if (child.flushTimer !== undefined) {
        clearTimeoutFn(child.flushTimer);
        child.flushTimer = undefined;
      }
      if (error && !terminalStatus(child.status)) {
        child.status = "failed";
        child.error = child.error || `Parent Pi run failed before this subagent completed.`;
        addLifecycle(child, formatStats({ status: "failed", toolCount: child.toolCount, durationMs: child.durationMs, tokens: child.tokens, error: child.error }), { redact });
        child.fullMarkdown = renderChildMarkdown(child, { requestId, redact });
        child.dirty = true;
      }
      await flushChild(child, { final: true });
    }
    traceSoft("subagent_canvas.stopped", { canvasCount: metadata().length, resultLength: result?.length || 0, hasError: Boolean(error) });
    return { subagentCanvases: metadata() };
  }

  return {
    start,
    handle,
    stop,
    get started() { return started; },
    get stopped() { return stopped; },
    get canvasCount() { return metadata().length; },
  };
}
