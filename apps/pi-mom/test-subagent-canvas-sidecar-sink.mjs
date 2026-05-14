import assert from "node:assert/strict";
import {
  createSubagentCanvasSidecarSink,
  formatSubagentCanvasFooter,
} from "./lib/subagent-canvas-sidecar-sink.mjs";

function makeFakeClient({ createImpl, editImpl, accessSetImpl } = {}) {
  const creates = [];
  const edits = [];
  const accessSets = [];
  return {
    creates,
    edits,
    accessSets,
    canvases: {
      create: async (args) => {
        creates.push(args);
        if (createImpl) return createImpl(args, creates.length);
        return { ok: true, canvas_id: `F${creates.length}` };
      },
      edit: async (args) => {
        edits.push(args);
        if (editImpl) return editImpl(args, edits.length);
        return { ok: true };
      },
      access: {
        set: async (args) => {
          accessSets.push(args);
          if (accessSetImpl) return accessSetImpl(args, accessSets.length);
          return { ok: true };
        },
      },
    },
  };
}

function finalMarkdown(client) {
  const replace = [...client.edits].reverse().find((edit) => edit.changes?.[0]?.operation === "replace");
  return replace?.changes?.[0]?.document_content?.markdown || client.creates.at(-1)?.document_content?.markdown || "";
}

const startEvt = (args = {}) => ({
  type: "tool_execution_start",
  toolCallId: "tc_subagent_1",
  toolName: "subagent",
  args,
});

const updateEvt = (partialResult, args = {}) => ({
  type: "tool_execution_update",
  toolCallId: "tc_subagent_1",
  toolName: "subagent",
  args,
  partialResult,
});

const endEvt = (result, args = {}) => ({
  type: "tool_execution_end",
  toolCallId: "tc_subagent_1",
  toolName: "subagent",
  args,
  result,
  isError: false,
});

// Case 1: child progress/result creates one canvas, grants access, and final markdown is structured.
{
  const client = makeFakeClient();
  const sink = createSubagentCanvasSidecarSink({
    client,
    channel: "C1",
    threadTs: "1.0",
    requestId: "req_sidecar_1",
    teamId: "T1",
    accessUserIds: ["U1"],
  });
  sink.start();
  const args = { agent: "team-scout", task: "Inspect apps/pi-mom/lib/routes.mjs", cwd: "/app/apps/pi-mom" };
  sink.handle(startEvt(args));
  sink.handle(updateEvt({
    details: {
      runId: "run_1",
      mode: "single",
      progress: [{
        index: 0,
        agent: "team-scout",
        status: "running",
        task: args.task,
        currentTool: "read",
        currentToolArgs: '{"path":"apps/pi-mom/lib/routes.mjs"}',
        currentPath: "apps/pi-mom/lib/routes.mjs",
        recentTools: [],
        recentOutput: [],
        toolCount: 1,
        tokens: 123,
        durationMs: 900,
      }],
      results: [],
    },
  }, args));
  sink.handle(endEvt({
    content: [{ type: "text", text: "done" }],
    details: {
      runId: "run_1",
      mode: "single",
      results: [{
        agent: "team-scout",
        task: args.task,
        exitCode: 0,
        model: "openai-codex/gpt-5.5",
        usage: { input: 10, output: 20, turns: 1 },
        progressSummary: { toolCount: 1, tokens: 30, durationMs: 1200 },
        toolCalls: [{ text: "read apps/pi-mom/lib/routes.mjs", expandedText: "read { path: apps/pi-mom/lib/routes.mjs }" }],
        finalOutput: "Found the team route configuration and subagent allowlist.",
      }],
      progress: [{
        index: 0,
        agent: "team-scout",
        status: "completed",
        task: args.task,
        recentTools: [{ tool: "read", args: '{"path":"apps/pi-mom/lib/routes.mjs"}', endMs: 10 }],
        recentOutput: [],
        toolCount: 1,
        tokens: 30,
        durationMs: 1200,
      }],
    },
  }, args));

  const out = await sink.stop({ result: "parent result" });
  assert.equal(client.creates.length, 1, "one canvas created");
  assert.equal(client.creates[0].channel_id, undefined, "standalone canvas");
  assert.equal(client.accessSets.length, 2, "user and channel access granted");
  assert.equal(out.subagentCanvases.length, 1);
  assert.equal(out.subagentCanvases[0].url, "https://app.slack.com/docs/T1/F1");
  assert.equal(out.subagentCanvases[0].status, "completed");

  const markdown = finalMarkdown(client);
  assert.match(markdown, /# Subagent: team-scout/);
  assert.match(markdown, /Request: req_sidecar_1/);
  assert.match(markdown, /Parent tool call: tc_subagent_1/);
  assert.match(markdown, /CWD: \/app\/apps\/pi-mom/);
  assert.match(markdown, /Status: completed/);
  assert.match(markdown, /Model: openai-codex\/gpt-5\.5/);
  assert.match(markdown, /Inspect apps\/pi-mom\/lib\/routes\.mjs/);
  assert.match(markdown, /tool read apps\/pi-mom\/lib\/routes\.mjs/);
  assert.match(markdown, /completed: 1 tools/);
  assert.match(markdown, /Tool targets observed[\s\S]*apps\/pi-mom\/lib\/routes\.mjs/);
  assert.match(markdown, /Found the team route configuration/);
}

// Case 2: redaction and truncation are applied to canvas markdown.
{
  const client = makeFakeClient();
  const sink = createSubagentCanvasSidecarSink({
    client,
    channel: "C2",
    requestId: "req_sidecar_2",
    teamId: "T2",
  });
  const longOutput = `sk-proj-secretvalue ${"x".repeat(7000)}`;
  sink.handle(endEvt({
    details: {
      runId: "run_2",
      results: [{
        agent: "team-scout",
        task: "Read env OPENAI_API_KEY=should-not-leak and summarize.",
        exitCode: 0,
        finalOutput: longOutput,
        progressSummary: { toolCount: 0, tokens: 1, durationMs: 1 },
      }],
    },
  }));
  await sink.stop({});
  const markdown = finalMarkdown(client);
  assert.doesNotMatch(markdown, /sk-proj-secretvalue/);
  assert.doesNotMatch(markdown, /should-not-leak/);
  assert.match(markdown, /sk-proj-\[REDACTED\]/);
  assert.match(markdown, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(markdown, /truncated by pi-mom/);
  assert.ok(markdown.length < 7500, "markdown is bounded");
}

// Case 3: canvas create failures are fail-soft.
{
  const client = makeFakeClient({
    createImpl: async () => {
      const err = new Error("not_authed");
      err.data = { error: "not_authed" };
      throw err;
    },
  });
  const sink = createSubagentCanvasSidecarSink({ client, channel: "C3", requestId: "req_sidecar_3", teamId: "T3" });
  sink.handle(endEvt({
    details: { results: [{ agent: "team-scout", task: "x", exitCode: 0, finalOutput: "ok" }] },
  }));
  const out = await sink.stop({});
  assert.equal(client.creates.length, 1, "create attempted");
  assert.equal(client.edits.length, 0, "no edits after failed create");
  assert.deepEqual(out.subagentCanvases, [], "no footer metadata without a canvas");
}

// Case 4: canvas edit failures are fail-soft and still return link metadata.
{
  const client = makeFakeClient({
    editImpl: async () => {
      const err = new Error("invalid_arguments");
      err.data = { error: "invalid_arguments" };
      throw err;
    },
  });
  const sink = createSubagentCanvasSidecarSink({ client, channel: "C4", requestId: "req_sidecar_4", teamId: "T4", flushBytes: 1 });
  const args = { agent: "team-scout", task: "Inspect target" };
  sink.handle(updateEvt({ details: { progress: [{ agent: "team-scout", status: "running", task: "Inspect target", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 }] } }, args));
  sink.handle(endEvt({ details: { results: [{ agent: "team-scout", task: "Inspect target", exitCode: 0, finalOutput: "ok" }] } }, args));
  const out = await sink.stop({});
  assert.equal(client.creates.length, 1);
  assert.ok(client.edits.length >= 1, "edit attempted");
  assert.equal(out.subagentCanvases.length, 1, "metadata survives edit failure");
  assert.equal(out.subagentCanvases[0].url, "https://app.slack.com/docs/T4/F1");
}

// Case 5: non-subagent tool lifecycle events are ignored.
{
  const client = makeFakeClient();
  const sink = createSubagentCanvasSidecarSink({ client, channel: "C5", requestId: "req_sidecar_5", teamId: "T5" });
  sink.handle({ type: "tool_execution_end", toolCallId: "tc_read", toolName: "read", result: { content: [{ type: "text", text: "x" }] } });
  const out = await sink.stop({});
  assert.equal(client.creates.length, 0);
  assert.deepEqual(out.subagentCanvases, []);
}

// Case 6: legacy/nested toolCall event shape is tolerated.
{
  const client = makeFakeClient();
  const sink = createSubagentCanvasSidecarSink({ client, channel: "C6", requestId: "req_sidecar_6", teamId: "T6" });
  sink.handle({
    type: "tool_execution_end",
    toolCall: {
      toolCallId: "legacy_tc",
      toolName: "subagent",
      args: { agent: "team-scout", task: "legacy shape" },
      result: { details: { results: [{ agent: "team-scout", task: "legacy shape", exitCode: 0, finalOutput: "legacy ok" }] } },
    },
  });
  const out = await sink.stop({});
  assert.equal(client.creates.length, 1);
  assert.equal(out.subagentCanvases[0].canvasId, "F1");
  assert.match(finalMarkdown(client), /legacy ok/);
}

// Case 7: footer helper formats only linked canvases and escapes link text separators.
{
  const footer = formatSubagentCanvasFooter([
    { agent: "team|scout", title: "team|scout", status: "completed", url: "https://example.test/canvas" },
    { agent: "missing-url", status: "completed" },
  ]);
  assert.match(footer, /\*Subagent canvases\*/);
  assert.match(footer, /<https:\/\/example\.test\/canvas\|team¦scout — completed>/);
  assert.doesNotMatch(footer, /missing-url/);
}

console.log("subagent-canvas-sidecar-sink tests passed");
