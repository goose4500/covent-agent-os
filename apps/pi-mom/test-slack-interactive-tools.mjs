// Tests for extensions/slack-interactive-tools.ts.
//
// Three Pi custom tools (slack_approval_card, slack_choice_card,
// slack_input_request) that wrap the rich-block-kit methods on
// slack-ui-context.mjs (confirmWithPreview, selectWithContext,
// inputRequest). Each test injects a fake `pi` ExtensionAPI plus a fake
// `ctx` whose `ui` exposes the relevant primitive method.

import assert from "node:assert/strict";
import slackInteractiveTools from "../../extensions/slack-interactive-tools.ts";

function makeFakePi() {
  const registered = [];
  return {
    registered,
    registerTool: (definition) => registered.push(definition),
    on: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({}),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "high",
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: { on: () => {}, off: () => {}, emit: () => {} },
  };
}

function findTool(pi, name) {
  const tool = pi.registered.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool;
}

function makeCtx(uiOverrides = {}) {
  return {
    ui: {
      // Default stubs so optional-chained guards (`ui?.confirmWithPreview`)
      // see the property only on the methods the test wants to exercise.
      ...uiOverrides,
    },
    hasUI: true,
  };
}

// Case 1: all three tools register with expected names and parameter shapes.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const names = fakePi.registered.map((t) => t.name).sort();
  assert.deepEqual(names, ["slack_approval_card", "slack_choice_card", "slack_input_request", "slack_post_artifact"]);

  const approval = findTool(fakePi, "slack_approval_card");
  assert.equal(typeof approval.parameters, "object");
  assert.equal(typeof approval.execute, "function");
  assert.ok(approval.promptSnippet, "approval has promptSnippet");
  assert.ok(Array.isArray(approval.promptGuidelines));

  const choice = findTool(fakePi, "slack_choice_card");
  assert.ok(choice.parameters, "choice has params");
  const input = findTool(fakePi, "slack_input_request");
  assert.ok(input.parameters, "input has params");
}

// Case 2: slack_approval_card returns "approved" when ctx.ui.confirmWithPreview resolves true.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const approval = findTool(fakePi, "slack_approval_card");
  const calls = [];
  const ctx = makeCtx({
    confirmWithPreview: async (title, summary, previewMd, opts) => {
      calls.push({ title, summary, previewMd, opts });
      return true;
    },
  });
  const r = await approval.execute("tc1", {
    title: "Create issue?",
    summary: "Filing in Backlog",
    preview_md: "**Title:** Bug X\n\nDescription...",
    approve_label: "File it",
    timeout_ms: 5000,
  }, undefined, undefined, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text, "approved");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, "Create issue?");
  assert.equal(calls[0].opts.approveLabel, "File it");
  assert.equal(calls[0].opts.timeout, 5000);
}

// Case 3: slack_approval_card returns "rejected" when confirmWithPreview resolves false.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const approval = findTool(fakePi, "slack_approval_card");
  const ctx = makeCtx({ confirmWithPreview: async () => false });
  const r = await approval.execute("tc2", {
    title: "X", summary: "Y", preview_md: "Z",
  }, undefined, undefined, ctx);
  assert.equal(r.content[0].text, "rejected");
}

// Case 4: slack_approval_card returns "timeout" when the signal is aborted.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const approval = findTool(fakePi, "slack_approval_card");
  const ctx = makeCtx({ confirmWithPreview: async () => false });
  const ac = new AbortController();
  ac.abort();
  const r = await approval.execute("tc3", {
    title: "X", summary: "Y", preview_md: "Z",
  }, ac.signal, undefined, ctx);
  assert.equal(r.content[0].text, "timeout");
}

// Case 5: slack_approval_card returns isError when ctx is missing or lacks confirmWithPreview.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const approval = findTool(fakePi, "slack_approval_card");

  // ctx is undefined.
  let r = await approval.execute("tc4a", {
    title: "X", summary: "Y", preview_md: "Z",
  }, undefined, undefined, undefined);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Slack-bound/);

  // ctx.ui exists but no confirmWithPreview.
  r = await approval.execute("tc4b", {
    title: "X", summary: "Y", preview_md: "Z",
  }, undefined, undefined, { ui: {} });
  assert.equal(r.isError, true);
}

// Case 6: slack_approval_card surfaces thrown errors with isError.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const approval = findTool(fakePi, "slack_approval_card");
  const ctx = makeCtx({
    confirmWithPreview: async () => {
      throw new Error("slack post failed");
    },
  });
  const r = await approval.execute("tc5", {
    title: "X", summary: "Y", preview_md: "Z",
  }, undefined, undefined, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /slack post failed/);
}

// Case 7: slack_choice_card returns the chosen option id verbatim.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const choice = findTool(fakePi, "slack_choice_card");
  const calls = [];
  const ctx = makeCtx({
    selectWithContext: async (title, summary, options, opts) => {
      calls.push({ title, summary, options, opts });
      return "opt_two";
    },
  });
  const r = await choice.execute("tc6", {
    title: "Pick one",
    summary: "Found 3 matches",
    options: [
      { id: "opt_one", label: "First", context_md: "FE-1 — Bug" },
      { id: "opt_two", label: "Second", context_md: "FE-2 — Bug" },
      { id: "opt_three", label: "Third" },
    ],
    timeout_ms: 9000,
  }, undefined, undefined, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text, "opt_two");
  assert.equal(calls[0].options.length, 3);
  assert.equal(calls[0].opts.timeout, 9000);
}

// Case 8: slack_choice_card returns "timeout" when selectWithContext resolves undefined.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const choice = findTool(fakePi, "slack_choice_card");
  const ctx = makeCtx({ selectWithContext: async () => undefined });
  const r = await choice.execute("tc7", {
    title: "Pick",
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  }, undefined, undefined, ctx);
  assert.equal(r.content[0].text, "timeout");
}

// Case 9: slack_choice_card returns isError when ctx.ui lacks selectWithContext.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const choice = findTool(fakePi, "slack_choice_card");
  const r = await choice.execute("tc8", {
    title: "Pick",
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  }, undefined, undefined, { ui: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Slack-bound/);
}

// Case 10: slack_input_request returns user text.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const input = findTool(fakePi, "slack_input_request");
  const calls = [];
  const ctx = makeCtx({
    inputRequest: async (title, prompt, opts) => {
      calls.push({ title, prompt, opts });
      return "Priority should be P1";
    },
  });
  const r = await input.execute("tc9", {
    title: "What priority?",
    prompt: "Choose between P0-P4.",
    placeholder: "P1",
    multiline: false,
    timeout_ms: 7000,
  }, undefined, undefined, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text, "Priority should be P1");
  assert.equal(calls[0].opts.multiline, false);
  assert.equal(calls[0].opts.placeholder, "P1");
  assert.equal(calls[0].opts.timeout, 7000);
}

// Case 11: slack_input_request returns "skipped" when inputRequest resolves undefined.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const input = findTool(fakePi, "slack_input_request");
  const ctx = makeCtx({ inputRequest: async () => undefined });
  const r = await input.execute("tc10", {
    title: "What?",
    prompt: "Anything",
  }, undefined, undefined, ctx);
  assert.equal(r.content[0].text, "skipped");
}

// Case 12: slack_input_request returns "timeout" when signal aborted.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const input = findTool(fakePi, "slack_input_request");
  const ctx = makeCtx({ inputRequest: async () => undefined });
  const ac = new AbortController();
  ac.abort();
  const r = await input.execute("tc11", {
    title: "What?",
    prompt: "Anything",
  }, ac.signal, undefined, ctx);
  assert.equal(r.content[0].text, "timeout");
}

// Case 13: slack_input_request defaults multiline to true.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const input = findTool(fakePi, "slack_input_request");
  let observedMultiline;
  const ctx = makeCtx({
    inputRequest: async (_title, _prompt, opts) => {
      observedMultiline = opts.multiline;
      return "ok";
    },
  });
  await input.execute("tc12", {
    title: "What?",
    prompt: "Anything",
  }, undefined, undefined, ctx);
  assert.equal(observedMultiline, true);
}

// Case 14: AbortSignal is forwarded into the underlying ctx.ui call.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const approval = findTool(fakePi, "slack_approval_card");
  let observedSignal;
  const ctx = makeCtx({
    confirmWithPreview: async (_t, _s, _p, opts) => {
      observedSignal = opts.signal;
      return true;
    },
  });
  const ac = new AbortController();
  await approval.execute("tc13", {
    title: "X", summary: "Y", preview_md: "Z",
  }, ac.signal, undefined, ctx);
  assert.equal(observedSignal, ac.signal, "signal forwarded");
}

// Case 15: slack_post_artifact registers with the expected parameter shape.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const tool = findTool(fakePi, "slack_post_artifact");
  assert.equal(typeof tool.parameters, "object");
  assert.equal(typeof tool.execute, "function");
  assert.ok(tool.promptSnippet);
  assert.ok(Array.isArray(tool.promptGuidelines));
}

// Case 16: slack_post_artifact returns "uploaded …" on success and forwards options to postFile.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const tool = findTool(fakePi, "slack_post_artifact");
  const calls = [];
  const ctx = makeCtx({
    postFile: async (filename, filePath, mimeType, opts) => {
      calls.push({ filename, filePath, mimeType, opts });
      return { ok: true, upload: { files: [{ files: [{ id: "F1", permalink: "https://slack/F1" }] }] } };
    },
  });
  const r = await tool.execute("tc15", {
    filename: "sales.csv",
    file_path: "/tmp/sales.csv",
    mime_type: "text/csv",
    description: "Q1 sales",
    regenerate_prompt: "generate a sales CSV for Q1",
  }, undefined, undefined, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(r.content[0].text, "uploaded sales.csv");
  assert.equal(r.details?.permalink, "https://slack/F1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filename, "sales.csv");
  assert.equal(calls[0].filePath, "/tmp/sales.csv");
  assert.equal(calls[0].mimeType, "text/csv");
  assert.equal(calls[0].opts.description, "Q1 sales");
  assert.equal(calls[0].opts.regeneratePrompt, "generate a sales CSV for Q1");
}

// Case 17: slack_post_artifact surfaces postFile errors as isError results.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const tool = findTool(fakePi, "slack_post_artifact");
  const ctx = makeCtx({ postFile: async () => ({ ok: false, error: "file_too_large" }) });
  const r = await tool.execute("tc16", {
    filename: "huge.bin",
    file_path: "/tmp/huge.bin",
  }, undefined, undefined, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /file_too_large/);
}

// Case 18: slack_post_artifact returns isError when ctx.ui.postFile is missing (non-Slack-bound turn).
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const tool = findTool(fakePi, "slack_post_artifact");
  const ctx = makeCtx({});
  const r = await tool.execute("tc17", {
    filename: "x.txt",
    file_path: "/tmp/x.txt",
  }, undefined, undefined, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Slack-bound/);
}

// Case 19: slack_post_artifact forwards AbortSignal to postFile.
{
  const fakePi = makeFakePi();
  slackInteractiveTools(fakePi);
  const tool = findTool(fakePi, "slack_post_artifact");
  let observedSignal;
  const ctx = makeCtx({
    postFile: async (_f, _p, _m, opts) => {
      observedSignal = opts?.signal;
      return { ok: true, upload: { files: [] } };
    },
  });
  const ac = new AbortController();
  await tool.execute("tc18", {
    filename: "a.txt",
    file_path: "/tmp/a.txt",
  }, ac.signal, undefined, ctx);
  assert.equal(observedSignal, ac.signal);
}

console.log("slack-interactive-tools tests passed");
