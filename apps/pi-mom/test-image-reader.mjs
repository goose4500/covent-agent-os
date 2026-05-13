// Tests for extensions/image-reader.ts (Phase 3 / Worker E).
//
// Mirrors the structure of test-linear-tools.mjs: stub `pi.registerTool`
// to capture the registration, then drive the captured `execute` directly
// with a stub Slack client and a stub `downloadFileBytes` (injected via
// the factory's resizeImage hook is *not* the right seam — the network
// calls go through the Phase 1 helpers, which we override below).
//
// We can't inject a fake slack-thread-fetcher cleanly without a module
// graph hack, so instead we exercise the factory's own seams:
//   - slackClient: drives `hydrateFiles({ client })`
//   - botToken: drives `downloadFileBytes({ botToken })` via global fetch
//   - resizeImage: factory parameter for the resize step
//   - ctx.model.input: the vision-capability guard reads it from ctx
// And we patch `globalThis.fetch` for the download step (the Phase 1
// helper uses global fetch when no `fetchImpl` is passed).

import assert from "node:assert/strict";
import { createImageReaderFactory } from "../../extensions/image-reader.ts";

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

// Build a fake Slack client whose `files.info` returns the supplied
// `fileMap` (file_id -> file object) or throws when `forceError` is set.
function makeFakeSlackClient(fileMap, { forceError } = {}) {
  return {
    files: {
      info: async ({ file }) => {
        if (forceError) throw new Error(forceError);
        const f = fileMap[file];
        if (!f) return { ok: false };
        return { ok: true, file: f };
      },
    },
  };
}

// Drop-in fetch stub for `downloadFileBytes`. Records every call.
function installFakeFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function visionModel() {
  return { input: ["text", "image"], id: "test/vision", provider: "test" };
}
function textOnlyModel() {
  return { input: ["text"], id: "test/text-only", provider: "test" };
}

// 1. Missing file_id → isError with the right message.
{
  const fakePi = makeFakePi();
  createImageReaderFactory({
    slackClient: makeFakeSlackClient({}),
    botToken: "xoxb-test",
  })(fakePi);
  const tool = findTool(fakePi, "read_image_content");
  const r = await tool.execute("tc1", { file_id: "" }, undefined, undefined, {
    model: visionModel(),
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /file_id is required/);
}

// 2. Lookup error from hydrateFiles → isError with the surfaced reason.
{
  const fakePi = makeFakePi();
  const fakeSlack = makeFakeSlackClient({}, { forceError: "not_found" });
  createImageReaderFactory({ slackClient: fakeSlack, botToken: "xoxb-test" })(fakePi);
  const tool = findTool(fakePi, "read_image_content");
  const r = await tool.execute(
    "tc2",
    { file_id: "F123" },
    undefined,
    undefined,
    { model: visionModel() },
  );
  assert.equal(r.isError, true);
  // hydrateFiles surfaces the inner error string verbatim in `.error`.
  assert.match(r.content[0].text, /file lookup failed:.*not_found/);
}

// 3. Non-image mimetype → isError ("not an image").
{
  const fakePi = makeFakePi();
  const fakeSlack = makeFakeSlackClient({
    F_TXT: {
      id: "F_TXT",
      name: "notes.txt",
      mimetype: "text/plain",
      url_private: "https://files.slack.com/x/notes.txt",
      permalink: "https://slack.com/x/notes.txt",
    },
  });
  createImageReaderFactory({ slackClient: fakeSlack, botToken: "xoxb-test" })(fakePi);
  const tool = findTool(fakePi, "read_image_content");
  const r = await tool.execute(
    "tc3",
    { file_id: "F_TXT" },
    undefined,
    undefined,
    { model: visionModel() },
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /is not an image/);
}

// 4. Happy path on a vision-capable model → image block returned.
{
  const fakePi = makeFakePi();
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fakeSlack = makeFakeSlackClient({
    F_PNG: {
      id: "F_PNG",
      name: "diagram.png",
      mimetype: "image/png",
      url_private: "https://files.slack.com/x/diagram.png",
      permalink: "https://slack.com/x/diagram.png",
    },
  });
  const fetchStub = installFakeFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
    arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength),
  }));
  try {
    createImageReaderFactory({
      slackClient: fakeSlack,
      botToken: "xoxb-test",
      // No resizeImage — falls through with raw bytes.
    })(fakePi);
    const tool = findTool(fakePi, "read_image_content");
    const r = await tool.execute(
      "tc4",
      { file_id: "F_PNG" },
      undefined,
      undefined,
      { model: visionModel() },
    );
    assert.equal(r.isError, false);
    assert.equal(r.content.length, 2, "text + image content blocks");
    assert.equal(r.content[0].type, "text");
    assert.match(r.content[0].text, /diagram\.png/);
    assert.equal(r.content[1].type, "image");
    assert.equal(r.content[1].mimeType, "image/png");
    assert.equal(r.content[1].data, pngBytes.toString("base64"));
    assert.equal(r.details.fileId, "F_PNG");
    assert.equal(r.details.sizeBytes, pngBytes.length);
    assert.equal(fetchStub.calls.length, 1);
    assert.match(String(fetchStub.calls[0].init.headers.Authorization), /Bearer xoxb-test/);
  } finally {
    fetchStub.restore();
  }
}

// 5. Text-only model → text-only fallback, no image content block, no isError.
{
  const fakePi = makeFakePi();
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const fakeSlack = makeFakeSlackClient({
    F_PNG2: {
      id: "F_PNG2",
      name: "shot.png",
      mimetype: "image/png",
      url_private: "https://files.slack.com/x/shot.png",
      permalink: "https://slack.com/x/shot.png",
    },
  });
  const fetchStub = installFakeFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
    arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength),
  }));
  try {
    createImageReaderFactory({ slackClient: fakeSlack, botToken: "xoxb-test" })(fakePi);
    const tool = findTool(fakePi, "read_image_content");
    const r = await tool.execute(
      "tc5",
      { file_id: "F_PNG2" },
      undefined,
      undefined,
      { model: textOnlyModel() },
    );
    assert.equal(r.isError, false);
    assert.equal(r.content.length, 1, "text-only fallback");
    assert.equal(r.content[0].type, "text");
    assert.match(r.content[0].text, /does not support image input/);
    assert.match(r.content[0].text, /F_PNG2/);
    assert.equal(r.details.modelNotVisionCapable, true);
  } finally {
    fetchStub.restore();
  }
}

// 6. downloadFileBytes returns an error (auth_failure path) → isError.
{
  const fakePi = makeFakePi();
  const fakeSlack = makeFakeSlackClient({
    F_BAD: {
      id: "F_BAD",
      name: "x.png",
      mimetype: "image/png",
      url_private: "https://files.slack.com/x/bad.png",
      permalink: "https://slack.com/x/bad.png",
    },
  });
  // Slack returning the HTML login page = auth_failure under the Phase 1
  // helper's content-type check.
  const fetchStub = installFakeFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
  try {
    createImageReaderFactory({ slackClient: fakeSlack, botToken: "xoxb-test" })(fakePi);
    const tool = findTool(fakePi, "read_image_content");
    const r = await tool.execute(
      "tc6",
      { file_id: "F_BAD" },
      undefined,
      undefined,
      { model: visionModel() },
    );
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /download failed:.*auth_failure/);
  } finally {
    fetchStub.restore();
  }
}

// 7. Pre-aborted signal → isError "aborted", no Slack/network calls.
{
  const fakePi = makeFakePi();
  let slackCalls = 0;
  const fakeSlack = {
    files: {
      info: async () => {
        slackCalls += 1;
        return { ok: true, file: {} };
      },
    },
  };
  let fetched = 0;
  const fetchStub = installFakeFetch(async () => {
    fetched += 1;
    return { ok: true, headers: { get: () => "image/png" }, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  try {
    createImageReaderFactory({ slackClient: fakeSlack, botToken: "xoxb-test" })(fakePi);
    const tool = findTool(fakePi, "read_image_content");
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute(
      "tc7",
      { file_id: "F123" },
      ac.signal,
      undefined,
      { model: visionModel() },
    );
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /aborted/);
    assert.equal(slackCalls, 0, "no files.info call after pre-abort");
    assert.equal(fetched, 0, "no fetch call after pre-abort");
  } finally {
    fetchStub.restore();
  }
}

// 8. resizeImage hook is honored when provided.
{
  const fakePi = makeFakePi();
  const rawBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const resizedBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe1]);
  const fakeSlack = makeFakeSlackClient({
    F_JPG: {
      id: "F_JPG",
      name: "pic.jpg",
      mimetype: "image/jpeg",
      url_private: "https://files.slack.com/x/pic.jpg",
      permalink: "https://slack.com/x/pic.jpg",
    },
  });
  const fetchStub = installFakeFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/jpeg" },
    arrayBuffer: async () => rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength),
  }));
  try {
    let resizeCalled = false;
    createImageReaderFactory({
      slackClient: fakeSlack,
      botToken: "xoxb-test",
      resizeImage: async (buf, mime) => {
        resizeCalled = true;
        assert.equal(mime, "image/jpeg");
        assert.ok(Buffer.isBuffer(buf));
        return { buffer: resizedBytes, mimeType: "image/jpeg", width: 800, height: 600, resized: true };
      },
    })(fakePi);
    const tool = findTool(fakePi, "read_image_content");
    const r = await tool.execute(
      "tc8",
      { file_id: "F_JPG" },
      undefined,
      undefined,
      { model: visionModel() },
    );
    assert.equal(r.isError, false);
    assert.equal(resizeCalled, true);
    assert.equal(r.content[1].data, resizedBytes.toString("base64"));
    assert.match(r.content[0].text, /800x600 px/);
    assert.equal(r.details.resized, true);
  } finally {
    fetchStub.restore();
  }
}

// 9. resizeImage that throws → fall through to raw bytes; tool still succeeds.
{
  const fakePi = makeFakePi();
  const rawBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe2]);
  const fakeSlack = makeFakeSlackClient({
    F_JPG2: {
      id: "F_JPG2",
      name: "pic2.jpg",
      mimetype: "image/jpeg",
      url_private: "https://files.slack.com/x/pic2.jpg",
      permalink: "https://slack.com/x/pic2.jpg",
    },
  });
  const fetchStub = installFakeFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/jpeg" },
    arrayBuffer: async () => rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength),
  }));
  try {
    const warnings = [];
    createImageReaderFactory({
      slackClient: fakeSlack,
      botToken: "xoxb-test",
      resizeImage: async () => {
        throw new Error("photon-unavailable");
      },
      warn: (m) => warnings.push(m),
    })(fakePi);
    const tool = findTool(fakePi, "read_image_content");
    const r = await tool.execute(
      "tc9",
      { file_id: "F_JPG2" },
      undefined,
      undefined,
      { model: visionModel() },
    );
    assert.equal(r.isError, false);
    assert.equal(r.content[1].data, rawBytes.toString("base64"));
    assert.ok(warnings.some((w) => /resize failed/.test(w)));
  } finally {
    fetchStub.restore();
  }
}

console.log("image-reader tests passed");
