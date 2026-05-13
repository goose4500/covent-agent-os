// Tests for lib/intake-orchestrator.mjs — the PRD-intake orchestrator that
// downloads a Slack zip, runs the Pi `intake` route, harvests proposals from
// the capture map, and posts a parent summary + per-proposal cards back into
// the Slack thread.
//
// All I/O is dependency-injected: fake `client`, fake `runTurn`, fake
// `resolveAction`, fake capture map, and fake zip helpers. No real Slack,
// Pi, network, or filesystem calls.

import assert from "node:assert/strict";
import {
  buildIntakePrompt,
  handleIntakeZip,
  PROMPT_AGGREGATE_LIMIT,
} from "./lib/intake-orchestrator.mjs";
import { _resetIntakeApprovalCounterForTests } from "./lib/intake-proposal-store.mjs";

// ---------- shared test helpers ----------

function makeFakeClient() {
  const calls = [];
  return {
    calls,
    chat: {
      async postMessage(args) {
        calls.push(args);
        // ts increments per call so tests can distinguish parent vs cards.
        return { ok: true, ts: `1700000000.${(calls.length).toString().padStart(6, "0")}` };
      },
    },
  };
}

function makeEvent(overrides = {}) {
  return {
    channel_id: "C_INTAKE",
    user_id: "U_jake",
    file_id: "F_zip1",
    message_ts: "1699999999.000100",
    ...overrides,
  };
}

function makeFileInfo(name = "prd-handoff.zip", extra = {}) {
  return {
    file: {
      id: "F_zip1",
      name,
      url_private_download: "https://files.slack.com/F_zip1/download",
      ...extra,
    },
  };
}

function fakeResolveAction() {
  // Mirrors what action-resolver.mjs returns for the `intake` route.
  return { name: "intake", tools: ["intake_propose_issues"], systemPromptSuffix: "", approvals: "none" };
}

function fakeZipHelpers({ files = [], skipped = [], totalBytes = 0, downloadError } = {}) {
  return {
    downloadSlackFile: async () => {
      if (downloadError) throw new Error(downloadError);
      return Buffer.from("zip-bytes");
    },
    extractZipBuffer: () => ({ files, skipped, totalBytes }),
  };
}

function resetEnv() {
  delete process.env._PI_INTAKE_REQUEST_ID;
}

// ---------- case 1: happy path — parent summary + per-proposal cards posted, pendingApprovals populated ----------
{
  resetEnv();
  _resetIntakeApprovalCounterForTests();

  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const captureMap = new Map();

  const zip = fakeZipHelpers({
    files: [
      { name: "a.md", relPath: "a.md", text: "# A", mediaType: "markdown", sizeBytes: 3, truncated: false },
      { name: "b.md", relPath: "b.md", text: "# B", mediaType: "markdown", sizeBytes: 3, truncated: false },
    ],
    skipped: [],
    totalBytes: 6,
  });

  const runTurn = async ({ prompt }) => {
    const reqId = process.env._PI_INTAKE_REQUEST_ID;
    assert.ok(reqId, "runTurn must see _PI_INTAKE_REQUEST_ID set");
    captureMap.set(reqId, [
      { title: "x", description: "y", priority: 2 },
      { title: "x2", description: "y2" },
    ]);
    assert.match(prompt, /You are receiving extracted PRD spec text/);
    return "done";
  };

  const result = await handleIntakeZip(
    { client, event: makeEvent(), fileInfo: makeFileInfo() },
    {
      pendingApprovals,
      runTurn,
      resolveAction: fakeResolveAction,
      proposalCapture: captureMap,
      botToken: "xoxb-test",
      zip,
    },
  );

  assert.equal(result.proposalCount, 2, "result.proposalCount should be 2");
  assert.equal(result.error, undefined, "no error on happy path");
  assert.equal(client.calls.length, 3, "should post 1 parent + 2 cards = 3 total");

  // Parent first.
  const parent = client.calls[0];
  assert.equal(parent.channel, "C_INTAKE");
  assert.equal(parent.thread_ts, "1699999999.000100");
  assert.ok(Array.isArray(parent.blocks), "parent post should use blocks");

  // 2 cards each in the thread.
  for (let i = 1; i < 3; i++) {
    assert.equal(client.calls[i].channel, "C_INTAKE");
    assert.equal(client.calls[i].thread_ts, "1699999999.000100");
    assert.ok(Array.isArray(client.calls[i].blocks), `card ${i} should use blocks`);
  }

  // pendingApprovals has 2 intake_proposal entries.
  const entries = [...pendingApprovals.values()];
  assert.equal(entries.length, 2, "pendingApprovals should have 2 entries");
  for (const entry of entries) {
    assert.equal(entry.type, "intake_proposal");
    assert.equal(entry.channel, "C_INTAKE");
    assert.equal(entry.threadTs, "1699999999.000100");
    assert.ok(entry.cardMessageTs, "card ts should be recorded");
    assert.ok(entry.parentMessageTs, "parent ts should be recorded");
    assert.equal(entry.proposalTotal, 2);
  }
  const indices = entries.map((e) => e.proposalIndex).sort();
  assert.deepEqual(indices, [1, 2], "proposalIndex should be 1 and 2");

  // env cleared after success.
  assert.equal(process.env._PI_INTAKE_REQUEST_ID, undefined, "env var must be cleared after run");
}

// ---------- case 2: non-zip filename returns { error: "not a zip" } and posts nothing ----------
{
  resetEnv();
  _resetIntakeApprovalCounterForTests();

  const client = makeFakeClient();
  const pendingApprovals = new Map();

  const result = await handleIntakeZip(
    { client, event: makeEvent(), fileInfo: makeFileInfo("notes.pdf") },
    {
      pendingApprovals,
      runTurn: async () => { throw new Error("should not be called"); },
      resolveAction: fakeResolveAction,
      proposalCapture: new Map(),
      botToken: "xoxb-test",
      zip: fakeZipHelpers(),
    },
  );

  assert.equal(result.error, "not a zip", "should error 'not a zip'");
  assert.equal(client.calls.length, 0, "no Slack messages posted for non-zip");
  assert.equal(pendingApprovals.size, 0, "no entries registered for non-zip");
}

// ---------- case 3: downloadSlackFile throws → posts "Intake failed to download", no cards, no entries ----------
{
  resetEnv();
  _resetIntakeApprovalCounterForTests();

  const client = makeFakeClient();
  const pendingApprovals = new Map();

  let runTurnCalled = false;

  const result = await handleIntakeZip(
    { client, event: makeEvent(), fileInfo: makeFileInfo() },
    {
      pendingApprovals,
      runTurn: async () => { runTurnCalled = true; return "x"; },
      resolveAction: fakeResolveAction,
      proposalCapture: new Map(),
      botToken: "xoxb-test",
      zip: fakeZipHelpers({ downloadError: "network down" }),
    },
  );

  assert.ok(result.error && /download/i.test(result.error), `result.error should mention download (got: ${result.error})`);
  assert.equal(runTurnCalled, false, "runTurn must not be called when download fails");
  assert.equal(client.calls.length, 1, "should post exactly one failure message");
  assert.match(
    String(client.calls[0].text || ""),
    /Intake failed to download/i,
    "failure message should say 'Intake failed to download'",
  );
  assert.equal(pendingApprovals.size, 0, "no entries registered after download failure");
}

// ---------- case 4: empty zip (files=[], skipped=[]) → posts "no files in zip", no Pi run ----------
{
  resetEnv();
  _resetIntakeApprovalCounterForTests();

  const client = makeFakeClient();
  const pendingApprovals = new Map();

  let runTurnCalled = false;

  const result = await handleIntakeZip(
    { client, event: makeEvent(), fileInfo: makeFileInfo() },
    {
      pendingApprovals,
      runTurn: async () => { runTurnCalled = true; return "x"; },
      resolveAction: fakeResolveAction,
      proposalCapture: new Map(),
      botToken: "xoxb-test",
      zip: fakeZipHelpers({ files: [], skipped: [], totalBytes: 0 }),
    },
  );

  assert.equal(runTurnCalled, false, "runTurn must not be called on empty zip");
  assert.equal(client.calls.length, 1, "should post exactly one 'no files' message");
  assert.match(
    String(client.calls[0].text || ""),
    /no files/i,
    "failure message should mention 'no files'",
  );
  assert.equal(pendingApprovals.size, 0, "no entries registered for empty zip");
  assert.equal(result.proposalCount, 0);
}

// ---------- case 5: runTurn throws → posts "Pi run failed"; pendingApprovals empty; env cleared ----------
{
  resetEnv();
  _resetIntakeApprovalCounterForTests();

  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const captureMap = new Map();

  const zip = fakeZipHelpers({
    files: [
      { name: "a.md", relPath: "a.md", text: "# A", mediaType: "markdown", sizeBytes: 3, truncated: false },
    ],
    skipped: [],
    totalBytes: 3,
  });

  const runTurn = async () => {
    throw new Error("pi blew up");
  };

  const result = await handleIntakeZip(
    { client, event: makeEvent(), fileInfo: makeFileInfo() },
    {
      pendingApprovals,
      runTurn,
      resolveAction: fakeResolveAction,
      proposalCapture: captureMap,
      botToken: "xoxb-test",
      zip,
    },
  );

  assert.ok(result.error && /pi run failed/i.test(result.error), `result.error should mention 'pi run failed' (got: ${result.error})`);
  assert.equal(client.calls.length, 1, "should post exactly one 'Pi run failed' message");
  assert.match(
    String(client.calls[0].text || ""),
    /Pi run failed/i,
    "failure message should mention 'Pi run failed'",
  );
  assert.equal(pendingApprovals.size, 0, "no cards registered after Pi run failure");
  assert.equal(process.env._PI_INTAKE_REQUEST_ID, undefined, "env var must be cleared after Pi run failure");
}

// ---------- case 6: _PI_INTAKE_REQUEST_ID is set DURING the runTurn call and cleared after ----------
{
  resetEnv();
  _resetIntakeApprovalCounterForTests();

  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const captureMap = new Map();

  const zip = fakeZipHelpers({
    files: [
      { name: "a.md", relPath: "a.md", text: "# A", mediaType: "markdown", sizeBytes: 3, truncated: false },
    ],
    skipped: [],
    totalBytes: 3,
  });

  let observedEnvAtRunTurn;
  const runTurn = async () => {
    observedEnvAtRunTurn = process.env._PI_INTAKE_REQUEST_ID;
    captureMap.set(observedEnvAtRunTurn, []);
    return "done";
  };

  await handleIntakeZip(
    { client, event: makeEvent(), fileInfo: makeFileInfo() },
    {
      pendingApprovals,
      runTurn,
      resolveAction: fakeResolveAction,
      proposalCapture: captureMap,
      botToken: "xoxb-test",
      zip,
    },
  );

  assert.ok(
    observedEnvAtRunTurn && observedEnvAtRunTurn.startsWith("intake_"),
    `runTurn must observe env var starting with 'intake_' (got: ${observedEnvAtRunTurn})`,
  );
  assert.equal(
    process.env._PI_INTAKE_REQUEST_ID,
    undefined,
    "env var must be cleared after the call",
  );
}

// ---------- case 7: captureMap returns empty → parent summary posted with proposalCount=0, no cards ----------
{
  resetEnv();
  _resetIntakeApprovalCounterForTests();

  const client = makeFakeClient();
  const pendingApprovals = new Map();
  const captureMap = new Map();

  const zip = fakeZipHelpers({
    files: [
      { name: "a.md", relPath: "a.md", text: "# A", mediaType: "markdown", sizeBytes: 3, truncated: false },
    ],
    skipped: [],
    totalBytes: 3,
  });

  const runTurn = async () => {
    // intentionally do NOT set anything in captureMap
    return "done";
  };

  const result = await handleIntakeZip(
    { client, event: makeEvent(), fileInfo: makeFileInfo() },
    {
      pendingApprovals,
      runTurn,
      resolveAction: fakeResolveAction,
      proposalCapture: captureMap,
      botToken: "xoxb-test",
      zip,
    },
  );

  assert.equal(result.proposalCount, 0, "proposalCount should be 0 on empty capture");
  assert.equal(client.calls.length, 1, "only parent summary should be posted; no cards");
  assert.equal(pendingApprovals.size, 0, "no entries registered when no proposals");
  assert.ok(Array.isArray(client.calls[0].blocks), "parent post uses blocks");
}

// ---------- case 8: buildIntakePrompt aggregate cap — 4 large files force a truncation note + bounded total length ----------
{
  const big = "x".repeat(80_000);
  const files = [
    { name: "a.md", relPath: "a.md", text: big, mediaType: "markdown", sizeBytes: 80_000, truncated: false },
    { name: "b.md", relPath: "b.md", text: big, mediaType: "markdown", sizeBytes: 80_000, truncated: false },
    { name: "c.md", relPath: "c.md", text: big, mediaType: "markdown", sizeBytes: 80_000, truncated: false },
    { name: "d.md", relPath: "d.md", text: big, mediaType: "markdown", sizeBytes: 80_000, truncated: false },
  ];

  const prompt = buildIntakePrompt({
    zipFilename: "big.zip",
    files,
    skipped: [],
    defaultTeamId: "TEAM",
    defaultProjectId: "PROJ",
    channel: "C1",
    threadTs: "1.1",
    user: "U1",
    requestId: "req_big",
  });

  assert.match(prompt, /truncated to keep prompt under cap/, "prompt must include the truncation notice");
  // Body sections + truncation notice should keep the overall prompt bounded
  // by PROMPT_AGGREGATE_LIMIT plus some bounded framing overhead. We allow a
  // generous 8KB headroom for the header, skipped, and the truncation line.
  assert.ok(
    prompt.length <= PROMPT_AGGREGATE_LIMIT + 8000,
    `prompt length should be bounded; got ${prompt.length} (limit + headroom = ${PROMPT_AGGREGATE_LIMIT + 8000})`,
  );
}

// ---------- case 9: buildIntakePrompt — per-file truncated:true flag renders ", truncated" in the header ----------
{
  const prompt = buildIntakePrompt({
    zipFilename: "z.zip",
    files: [
      { name: "a.md", relPath: "a.md", text: "# A", mediaType: "markdown", sizeBytes: 3, truncated: true },
      { name: "b.md", relPath: "b.md", text: "# B", mediaType: "markdown", sizeBytes: 3, truncated: false },
    ],
    skipped: [],
    defaultTeamId: "TEAM",
    defaultProjectId: "PROJ",
    channel: "C1",
    threadTs: "1.1",
    user: "U1",
    requestId: "req_trunc",
  });

  assert.match(prompt, /### a\.md \(markdown, 3 bytes, truncated\)/, "a.md header must include ', truncated'");
  assert.match(prompt, /### b\.md \(markdown, 3 bytes\)/, "b.md header must NOT include ', truncated'");
}

console.log("intake-orchestrator tests pass");
