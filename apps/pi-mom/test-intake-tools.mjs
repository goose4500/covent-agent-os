// Tests for extensions/intake-tools.ts.
//
// The factory registers ONE tool: intake_propose_issues. Unlike linear-tools,
// the tool's side effect is local — it writes the cleaned proposals array
// into a captureMap keyed by env._PI_INTAKE_REQUEST_ID. Tests inject a fake
// `pi` ExtensionAPI + an env snapshot + a fresh capture map and drive the
// tool's execute() directly.

import assert from "node:assert/strict";
import {
  createIntakeToolsFactory,
  intakeProposalCapture,
  _resetIntakeProposalCaptureForTests,
} from "../../extensions/intake-tools.ts";

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

// Case 1: factory registers exactly one tool with name "intake_propose_issues".
{
  _resetIntakeProposalCaptureForTests();
  const fakePi = makeFakePi();
  createIntakeToolsFactory({ env: { _PI_INTAKE_REQUEST_ID: "req_1" } })(fakePi);
  assert.equal(fakePi.registered.length, 1, "exactly one tool registered");
  assert.equal(fakePi.registered[0].name, "intake_propose_issues");
  const tool = findTool(fakePi, "intake_propose_issues");
  assert.deepEqual(tool.parameters.required, ["issues"]);
  // schema sanity: issues is an array with min/max items.
  assert.equal(tool.parameters.properties.issues.type, "array");
  assert.equal(tool.parameters.properties.issues.minItems, 1);
  assert.equal(tool.parameters.properties.issues.maxItems, 50);
  // each issue has the expected required fields.
  const itemSchema = tool.parameters.properties.issues.items;
  assert.deepEqual(itemSchema.required.sort(), ["description", "title"]);
}

// Case 2: tool execute with valid issues array + env._PI_INTAKE_REQUEST_ID
// → captureMap.get(requestId) returns the cleaned array.
{
  _resetIntakeProposalCaptureForTests();
  const captureMap = new Map();
  const fakePi = makeFakePi();
  createIntakeToolsFactory({
    env: { _PI_INTAKE_REQUEST_ID: "req_abc" },
    captureMap,
  })(fakePi);
  const tool = findTool(fakePi, "intake_propose_issues");
  const r = await tool.execute(
    "tc2",
    {
      issues: [
        {
          title: "Slice A: render endpoint returns 200",
          description: "Wire GET /a end-to-end through router, handler, and minimal renderer.",
          priority: 2,
          confidence: 0.8,
        },
        {
          title: "Slice B: write path persists row",
          description: "POST /b inserts a row and returns the new id.",
          priority: 3,
          suggested_team_id: "team-99",
          suggested_project_id: "proj-99",
          blocked_by: ["Slice A: render endpoint returns 200"],
        },
      ],
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(r.details.requestId, "req_abc");
  assert.equal(r.details.count, 2);
  assert.match(r.content[0].text, /Captured 2 proposed issue\(s\) for request req_abc/);

  const stored = captureMap.get("req_abc");
  assert.ok(Array.isArray(stored), "captureMap has an entry for req_abc");
  assert.equal(stored.length, 2);
  assert.equal(stored[0].title, "Slice A: render endpoint returns 200");
  assert.equal(stored[0].priority, 2);
  assert.equal(stored[0].confidence, 0.8);
  assert.equal(stored[1].suggested_team_id, "team-99");
  assert.equal(stored[1].suggested_project_id, "proj-99");
  assert.deepEqual(stored[1].blocked_by, ["Slice A: render endpoint returns 200"]);
}

// Case 3: tool execute called twice for the same requestId overwrites
// (no append/merge).
{
  _resetIntakeProposalCaptureForTests();
  const captureMap = new Map();
  const fakePi = makeFakePi();
  createIntakeToolsFactory({
    env: { _PI_INTAKE_REQUEST_ID: "req_dup" },
    captureMap,
  })(fakePi);
  const tool = findTool(fakePi, "intake_propose_issues");

  await tool.execute(
    "tc3a",
    { issues: [{ title: "First", description: "first body" }] },
    undefined,
    undefined,
    {},
  );
  assert.equal(captureMap.get("req_dup").length, 1);
  assert.equal(captureMap.get("req_dup")[0].title, "First");

  await tool.execute(
    "tc3b",
    {
      issues: [
        { title: "Second", description: "second body" },
        { title: "Third", description: "third body" },
      ],
    },
    undefined,
    undefined,
    {},
  );
  const stored = captureMap.get("req_dup");
  assert.equal(stored.length, 2, "second call overwrites, not appends");
  assert.equal(stored[0].title, "Second");
  assert.equal(stored[1].title, "Third");
}

// Case 4: empty-title entries are silently dropped from the stored array.
{
  _resetIntakeProposalCaptureForTests();
  const captureMap = new Map();
  const fakePi = makeFakePi();
  createIntakeToolsFactory({
    env: { _PI_INTAKE_REQUEST_ID: "req_drop" },
    captureMap,
  })(fakePi);
  const tool = findTool(fakePi, "intake_propose_issues");
  const r = await tool.execute(
    "tc4",
    {
      issues: [
        { title: "  ", description: "blank title (whitespace only)" },
        { title: "", description: "empty title" },
        { title: "Good slice", description: "valid body" },
      ],
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(r.details.count, 1);
  const stored = captureMap.get("req_drop");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].title, "Good slice");
}

// Case 5: tool execute without env._PI_INTAKE_REQUEST_ID returns isError: true.
{
  _resetIntakeProposalCaptureForTests();
  const captureMap = new Map();
  const fakePi = makeFakePi();
  createIntakeToolsFactory({ env: {}, captureMap })(fakePi);
  const tool = findTool(fakePi, "intake_propose_issues");
  const r = await tool.execute(
    "tc5",
    { issues: [{ title: "X", description: "Y" }] },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /_PI_INTAKE_REQUEST_ID/);
  assert.equal(captureMap.size, 0, "nothing stored when requestId missing");
}

// Case 6: tool execute with issues=[] (after dropping empties) still stores
// empty array and returns success with count=0. The schema requires
// minItems:1 so the SDK shouldn't deliver this, but the implementation must
// be robust to all-empty after cleaning.
{
  _resetIntakeProposalCaptureForTests();
  const captureMap = new Map();
  const fakePi = makeFakePi();
  createIntakeToolsFactory({
    env: { _PI_INTAKE_REQUEST_ID: "req_empty" },
    captureMap,
  })(fakePi);
  const tool = findTool(fakePi, "intake_propose_issues");
  const r = await tool.execute(
    "tc6",
    {
      issues: [
        { title: "", description: "drop me" },
        { title: "  ", description: "drop me too" },
      ],
    },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  assert.equal(r.details.count, 0);
  assert.match(r.content[0].text, /Captured 0 proposed issue/);
  const stored = captureMap.get("req_empty");
  assert.ok(Array.isArray(stored), "still stored an empty array");
  assert.equal(stored.length, 0);
}

// Case 7: per-issue title clamping to 240 chars.
{
  _resetIntakeProposalCaptureForTests();
  const captureMap = new Map();
  const fakePi = makeFakePi();
  createIntakeToolsFactory({
    env: { _PI_INTAKE_REQUEST_ID: "req_clamp" },
    captureMap,
  })(fakePi);
  const tool = findTool(fakePi, "intake_propose_issues");
  const longTitle = "A".repeat(500);
  const r = await tool.execute(
    "tc7",
    { issues: [{ title: longTitle, description: "body" }] },
    undefined,
    undefined,
    {},
  );
  assert.equal(r.isError, undefined);
  const stored = captureMap.get("req_clamp");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].title.length, 240, "title clamped to 240 chars");
  assert.ok(stored[0].title.endsWith("..."), "clamped title ends with ellipsis");
}

// Case 8: _resetIntakeProposalCaptureForTests clears the module-level map
// between tests when the default capture map is in use.
{
  // First, populate the module-level capture map via the default factory.
  const fakePi = makeFakePi();
  // Stash + restore the real env var so we don't bleed into other tests.
  const prev = process.env._PI_INTAKE_REQUEST_ID;
  process.env._PI_INTAKE_REQUEST_ID = "req_module";
  try {
    createIntakeToolsFactory()(fakePi); // no opts → uses process.env + intakeProposalCapture
    const tool = findTool(fakePi, "intake_propose_issues");
    await tool.execute(
      "tc8",
      { issues: [{ title: "Module-level", description: "body" }] },
      undefined,
      undefined,
      {},
    );
    assert.equal(intakeProposalCapture.size, 1);
    assert.equal(intakeProposalCapture.get("req_module").length, 1);

    _resetIntakeProposalCaptureForTests();
    assert.equal(intakeProposalCapture.size, 0, "reset helper clears module map");
  } finally {
    if (prev === undefined) delete process.env._PI_INTAKE_REQUEST_ID;
    else process.env._PI_INTAKE_REQUEST_ID = prev;
  }
}

console.log("✅ intake-tools tests pass");
