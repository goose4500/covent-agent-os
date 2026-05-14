import assert from "node:assert/strict";
import { createSession } from "./lib/pi-session.mjs";

function makeFakeMap(initial = {}) {
  const store = { ...initial };
  const setCalls = [];
  return {
    setCalls,
    async get(t) { return store[t]; },
    async set(t, v) { store[t] = v; setCalls.push({ t, v }); },
    async clear() { for (const k of Object.keys(store)) delete store[k]; },
  };
}

function makeFakeSessionManager({ openShouldThrow = false } = {}) {
  const created = [];
  const opened = [];
  return {
    created,
    opened,
    create(cwd) {
      const idx = created.length;
      const sm = { cwd, source: "create", getSessionFile: () => `/sess/new-${idx}.jsonl` };
      created.push(sm);
      return sm;
    },
    open(path) {
      if (openShouldThrow) throw new Error("corrupt session");
      const sm = { path, source: "open", getSessionFile: () => path };
      opened.push(sm);
      return sm;
    },
  };
}

// Case 1: no entry in map → create new SessionManager + persist file path.
{
  const map = makeFakeMap();
  const SM = makeFakeSessionManager();
  let capturedOpts;
  const runPi = async (_prompt, opts) => { capturedOpts = opts; return "ok"; };

  const { runTurn } = createSession({
    threadSessionMap: map,
    runPi,
    SessionManager: SM,
    fileExists: () => false,
    workdir: "/work",
  });

  const result = await runTurn({
    surface: "app_mention",
    threadTs: "1.2",
    prompt: "hello",
  });

  assert.equal(result, "ok");
  assert.equal(SM.created.length, 1, "new session created");
  assert.equal(SM.opened.length, 0, "no open call");
  assert.equal(capturedOpts.sessionManager, SM.created[0], "runPi got the created session");
  assert.equal(map.setCalls.length, 1, "map persisted once");
  assert.equal(map.setCalls[0].t, "1.2");
  assert.equal(map.setCalls[0].v, "/sess/new-0.jsonl");
}

// Case 2: map has entry + file exists → SessionManager.open() called, no new create.
{
  const map = makeFakeMap({ "1.5": "/sess/existing.jsonl" });
  const SM = makeFakeSessionManager();
  let capturedOpts;
  const runPi = async (_p, o) => { capturedOpts = o; return "resumed"; };

  const { runTurn } = createSession({
    threadSessionMap: map,
    runPi,
    SessionManager: SM,
    fileExists: (p) => p === "/sess/existing.jsonl",
    workdir: "/work",
  });

  const result = await runTurn({ surface: "assistant", threadTs: "1.5", prompt: "again" });

  assert.equal(result, "resumed");
  assert.equal(SM.opened.length, 1, "session opened from existing path");
  assert.equal(SM.opened[0].path, "/sess/existing.jsonl");
  assert.equal(SM.created.length, 0, "no new session created");
  assert.equal(capturedOpts.sessionManager.source, "open");
  // map.set still called to refresh lastTouched
  assert.equal(map.setCalls.length, 1);
  assert.equal(map.setCalls[0].v, "/sess/existing.jsonl");
}

// Case 3: map entry points to a file that no longer exists → fall back to create.
{
  const map = makeFakeMap({ "1.7": "/sess/gone.jsonl" });
  const SM = makeFakeSessionManager();
  const runPi = async () => "new";

  const { runTurn } = createSession({
    threadSessionMap: map,
    runPi,
    SessionManager: SM,
    fileExists: () => false,
    workdir: "/work",
  });

  await runTurn({ surface: "app_mention", threadTs: "1.7", prompt: "hi" });
  assert.equal(SM.created.length, 1, "stale entry → new session");
  assert.equal(SM.opened.length, 0, "no open attempted");
}

// Case 4: SessionManager.open() throws → fall back to create.
{
  const map = makeFakeMap({ "1.8": "/sess/corrupt.jsonl" });
  const SM = makeFakeSessionManager({ openShouldThrow: true });
  let traceCalls = [];
  const { runTurn } = createSession({
    threadSessionMap: map,
    runPi: async () => "ok",
    SessionManager: SM,
    fileExists: () => true,
    workdir: "/work",
    trace: (e, d) => traceCalls.push({ e, d }),
  });

  await runTurn({ surface: "app_mention", threadTs: "1.8", prompt: "hi" });
  assert.equal(SM.created.length, 1, "open failure → fallback create");
  const failTrace = traceCalls.find((t) => t.e === "pi_session.open_failed");
  assert.ok(failTrace, "pi_session.open_failed trace fired");
  assert.equal(failTrace.d.threadTs, "1.8");
}

// Case 5: trace events fire with surface + resumed flag.
{
  const map = makeFakeMap({ "2.0": "/sess/keep.jsonl" });
  const SM = makeFakeSessionManager();
  const traceCalls = [];
  const { runTurn } = createSession({
    threadSessionMap: map,
    runPi: async () => "ok",
    SessionManager: SM,
    fileExists: () => true,
    workdir: "/work",
    trace: (e, d) => traceCalls.push({ e, d }),
  });

  await runTurn({ surface: "assistant", threadTs: "2.0", prompt: "yo" });
  const resolved = traceCalls.find((t) => t.e === "pi_session.session_resolved");
  assert.ok(resolved);
  assert.equal(resolved.d.surface, "assistant");
  assert.equal(resolved.d.resumed, true);
  const persisted = traceCalls.find((t) => t.e === "pi_session.session_persisted");
  assert.ok(persisted);
  assert.equal(persisted.d.sessionFile, "/sess/keep.jsonl");
}

// Case 6: action.tools is intentionally ignored; the runner enables all tools by default.
{
  const map = makeFakeMap();
  const SM = makeFakeSessionManager();
  let captured;
  const traceCalls = [];
  const runPi = async (_p, o) => { captured = o; return "ok"; };

  const { runTurn } = createSession({
    threadSessionMap: map,
    runPi,
    SessionManager: SM,
    fileExists: () => false,
    workdir: "/work",
    trace: (e, d) => traceCalls.push({ e, d }),
  });

  await runTurn({
    surface: "app_mention",
    threadTs: "3.0",
    prompt: "hi",
    action: { name: "linear", tools: ["read"], systemPromptSuffix: "", approvals: "none" },
  });
  assert.equal(captured.tools, undefined, "runTurn no longer forwards route allowlists");
  assert.equal(traceCalls.find((t) => t.e === "pi_session.session_resolved")?.d.toolMode, "all");
}

// Case 7: omitted action → runPi opts have no tools key.
{
  const map = makeFakeMap();
  const SM = makeFakeSessionManager();
  let captured;
  const runPi = async (_p, o) => { captured = o; return "ok"; };

  const { runTurn } = createSession({
    threadSessionMap: map,
    runPi,
    SessionManager: SM,
    fileExists: () => false,
    workdir: "/work",
  });

  await runTurn({ surface: "app_mention", threadTs: "3.1", prompt: "hi" });
  assert.equal(captured.tools, undefined, "no action → tools key omitted");
}

// Case 8: even empty action.tools is ignored by route handling.
{
  const map = makeFakeMap();
  const SM = makeFakeSessionManager();
  let captured;
  const runPi = async (_p, o) => { captured = o; return "ok"; };

  const { runTurn } = createSession({
    threadSessionMap: map,
    runPi,
    SessionManager: SM,
    fileExists: () => false,
    workdir: "/work",
  });

  await runTurn({
    surface: "assistant",
    threadTs: "3.2",
    prompt: "hi",
    action: { name: "summarize", tools: [], systemPromptSuffix: "", approvals: "none" },
  });
  assert.equal(captured.tools, undefined, "empty route allowlist is ignored");
}

// Case 9: required-arg validation.
{
  const { runTurn } = createSession({
    threadSessionMap: makeFakeMap(),
    runPi: async () => "ok",
    SessionManager: makeFakeSessionManager(),
    fileExists: () => false,
  });
  await assert.rejects(runTurn({ prompt: "x" }), /threadTs/, "no threadTs → throw");
  await assert.rejects(runTurn({ threadTs: "t" }), /prompt/, "no prompt → throw");
  await assert.rejects(runTurn({ threadTs: "t", prompt: "" }), /prompt/, "empty prompt → throw");
}

console.log("pi-session tests passed");
