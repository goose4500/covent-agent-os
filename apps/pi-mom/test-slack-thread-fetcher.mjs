import assert from "node:assert/strict";
import {
  fetchFullThread,
  hydrateFiles,
  downloadFileBytes,
} from "./lib/slack-thread-fetcher.mjs";

// Build an async iterable of pages from a fixed list, with an optional
// `errorAfter` page count so we can simulate a mid-stream Slack error.
function makePaginator({ pages, errorAfter = null }) {
  return async function* () {
    let i = 0;
    for (const page of pages) {
      i++;
      if (errorAfter !== null && i > errorAfter) {
        throw new Error("simulated paginate error");
      }
      yield page;
    }
  };
}

function makeFakeClient({ pages, errorAfter = null, filesInfo = null } = {}) {
  const calls = [];
  const filesInfoCalls = [];
  return {
    calls,
    filesInfoCalls,
    paginate(method, options) {
      calls.push({ method, options });
      const iter = makePaginator({ pages: pages || [], errorAfter })();
      return iter;
    },
    files: {
      info: async (args) => {
        filesInfoCalls.push(args);
        if (typeof filesInfo !== "function") {
          throw new Error("no filesInfo mock provided");
        }
        return filesInfo(args);
      },
    },
  };
}

function makeMessages(n, startIndex = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ ts: `t${startIndex + i}`, text: `m${startIndex + i}` });
  }
  return out;
}

// Case 1: 5 messages in a single page → returns 5, partial: false, count: 5.
{
  const pages = [{ messages: makeMessages(5) }];
  const client = makeFakeClient({ pages });
  const res = await fetchFullThread({
    client,
    channel: "C1",
    rootTs: "1.0",
  });
  assert.equal(res.count, 5, "count === 5");
  assert.equal(res.messages.length, 5, "messages length === 5");
  assert.equal(res.partial, false, "not partial");
  assert.equal(res.error, undefined, "no error field");
  assert.equal(client.calls.length, 1, "paginate called once");
  assert.equal(client.calls[0].method, "conversations.replies");
  assert.equal(client.calls[0].options.channel, "C1");
  assert.equal(client.calls[0].options.ts, "1.0");
  assert.equal(client.calls[0].options.limit, 200);
  assert.equal(client.calls[0].options.include_all_metadata, true);
}

// Case 2: 3 pages × 200 = 600 messages → returns 600, partial: false.
{
  const pages = [
    { messages: makeMessages(200, 0) },
    { messages: makeMessages(200, 200) },
    { messages: makeMessages(200, 400) },
  ];
  const client = makeFakeClient({ pages });
  const res = await fetchFullThread({
    client,
    channel: "C2",
    rootTs: "2.0",
  });
  assert.equal(res.count, 600, "600 messages accumulated");
  assert.equal(res.partial, false, "not partial");
  assert.equal(res.messages[0].ts, "t0");
  assert.equal(res.messages[599].ts, "t599");
}

// Case 3: iterator throws after 2 pages → returns first 400 with
// partial: true, error: <msg>. (We accumulated pages 1 + 2 before
// the 3rd throw fired.)
{
  const pages = [
    { messages: makeMessages(200, 0) },
    { messages: makeMessages(200, 200) },
    { messages: makeMessages(200, 400) },
  ];
  const client = makeFakeClient({ pages, errorAfter: 2 });
  const res = await fetchFullThread({
    client,
    channel: "C3",
    rootTs: "3.0",
  });
  assert.equal(res.count, 400, "first 400 accumulated");
  assert.equal(res.partial, true, "partial after mid-loop error");
  assert.ok(res.error, "error field set");
  assert.match(res.error, /simulated paginate error/, "error preserved");
}

// Case 4: safetyCap: 100 with 3 pages × 200 → returns exactly 100, partial: true.
{
  const pages = [
    { messages: makeMessages(200, 0) },
    { messages: makeMessages(200, 200) },
    { messages: makeMessages(200, 400) },
  ];
  const client = makeFakeClient({ pages });
  const res = await fetchFullThread({
    client,
    channel: "C4",
    rootTs: "4.0",
    safetyCap: 100,
  });
  assert.equal(res.count, 100, "capped at 100");
  assert.equal(res.partial, true, "partial when capped");
  assert.equal(res.messages[99].ts, "t99", "last message is the 100th");
}

// Case 5: hydrateFiles with 3 input files, 2 succeed, 1 fails → returns 3 entries in input order;
// failed one has `error` field.
{
  const inputs = [
    { id: "F1", name: "one.png", mimetype: "image/png" },
    { id: "F2", name: "two.pdf", mimetype: "application/pdf" },
    { id: "F3", name: "three.csv", mimetype: "text/csv" },
  ];
  const client = makeFakeClient({
    filesInfo: async ({ file }) => {
      if (file === "F2") throw new Error("boom");
      return {
        file: {
          id: file,
          name: `${file}.enriched`,
          mimetype: "application/octet-stream",
          extra: true,
        },
      };
    },
  });
  const res = await hydrateFiles({ client, files: inputs });
  assert.equal(res.length, 3, "preserves input length");
  assert.equal(res[0].id, "F1", "order preserved (0)");
  assert.equal(res[1].id, "F2", "order preserved (1)");
  assert.equal(res[2].id, "F3", "order preserved (2)");
  assert.equal(res[0].extra, true, "F1 enriched");
  assert.ok(res[1].error, "F2 has error field");
  assert.match(res[1].error, /boom/, "F2 error preserved");
  assert.equal(res[1].name, "two.pdf", "stub falls back to input name");
  assert.equal(res[1].mimetype, "application/pdf", "stub falls back to input mimetype");
  assert.equal(res[2].extra, true, "F3 enriched");
  assert.equal(client.filesInfoCalls.length, 3, "three files.info calls");
}

// Case 6: hydrateFiles with empty array → returns [] immediately, no client calls.
{
  const client = makeFakeClient({
    filesInfo: async () => {
      throw new Error("should not be called");
    },
  });
  const res = await hydrateFiles({ client, files: [] });
  assert.deepEqual(res, [], "empty input → empty output");
  assert.equal(client.filesInfoCalls.length, 0, "no client calls");
}

// Helper: fabricate a Response-ish object for fetch mocks.
function makeResponse({ status = 200, contentType = "image/png", body = Buffer.from([1, 2, 3]) }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return contentType;
        return null;
      },
    },
    async arrayBuffer() {
      return body instanceof Buffer
        ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        : body;
    },
  };
}

// Case 7: downloadFileBytes with mocked fetch returning 200 + image/png → buffer + mimeType.
{
  const captured = [];
  const fetchImpl = async (url, init) => {
    captured.push({ url, init });
    return makeResponse({
      status: 200,
      contentType: "image/png",
      body: Buffer.from([7, 8, 9]),
    });
  };
  const res = await downloadFileBytes({
    url: "https://files.slack.com/x.png",
    botToken: "xoxb-test",
    fetchImpl,
  });
  assert.ok("buffer" in res, "has buffer");
  assert.ok(Buffer.isBuffer(res.buffer), "buffer is a Buffer");
  assert.deepEqual([...res.buffer], [7, 8, 9], "buffer matches body");
  assert.equal(res.mimeType, "image/png", "mimeType from content-type");
  assert.equal(captured.length, 1, "fetch called once");
  assert.equal(captured[0].url, "https://files.slack.com/x.png");
  assert.equal(
    captured[0].init.headers.Authorization,
    "Bearer xoxb-test",
    "Authorization header set",
  );
}

// Case 8: downloadFileBytes with mocked fetch returning 200 + text/html → auth_failure.
{
  const fetchImpl = async () =>
    makeResponse({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: Buffer.from("<html>login</html>"),
    });
  const res = await downloadFileBytes({
    url: "https://files.slack.com/x.png",
    botToken: "xoxb-test",
    fetchImpl,
  });
  assert.equal(res.error, "auth_failure", "text/html → auth_failure");
  assert.equal(res.buffer, undefined, "no buffer on auth failure");
}

// Case 9: downloadFileBytes with mocked fetch rejecting (timeout) → returns { error }, no throw.
{
  const fetchImpl = async () => {
    throw new Error("simulated timeout");
  };
  const res = await downloadFileBytes({
    url: "https://files.slack.com/x.png",
    botToken: "xoxb-test",
    fetchImpl,
  });
  assert.ok(res.error, "error field present");
  assert.match(res.error, /simulated timeout/, "error preserved");
}

// Bonus: downloadFileBytes with HTTP non-OK → returns http_<status> error.
{
  const fetchImpl = async () =>
    makeResponse({ status: 500, contentType: "text/plain", body: Buffer.from("oops") });
  const res = await downloadFileBytes({
    url: "https://files.slack.com/x.png",
    botToken: "xoxb-test",
    fetchImpl,
  });
  assert.equal(res.error, "http_500", "non-ok surfaces status");
}

console.log("slack-thread-fetcher tests passed");
