import assert from "node:assert/strict";
import { createPrewarmer } from "./lib/cache-prewarm.mjs";

function captureLogger() {
  const log = [];
  const warn = [];
  return {
    log: (msg) => log.push(msg),
    warn: (msg) => warn.push(msg),
    parse(stream) {
      return stream
        .filter((line) => line.startsWith("[pi-mom-trace] "))
        .map((line) => JSON.parse(line.slice("[pi-mom-trace] ".length)));
    },
    entries: { log, warn },
  };
}

// Case 1: disabled via env → start() does not call runPi.
{
  let calls = 0;
  const runPi = async () => { calls += 1; };
  const cap = captureLogger();
  const pre = createPrewarmer({ runPi, env: { PI_MOM_PREWARM_ENABLED: "false" }, log: cap.log, warn: cap.warn });
  await pre.start().started;
  assert.equal(calls, 0, "runPi should not be invoked when disabled");
  const traces = cap.parse(cap.entries.log);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].event, "cache.prewarm_skipped");
  assert.equal(traces[0].reason, "disabled");
}

// Case 2: enabled (default), no interval → one warmup call, success trace.
{
  let calls = 0;
  let lastPrompt;
  const runPi = async (p) => { calls += 1; lastPrompt = p; };
  const cap = captureLogger();
  const pre = createPrewarmer({ runPi, env: {}, log: cap.log, warn: cap.warn });
  const { started } = pre.start();
  await started;
  assert.equal(calls, 1, "runPi invoked exactly once at startup");
  assert.equal(lastPrompt, "ok", "default prompt is `ok`");
  const traces = cap.parse(cap.entries.log);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].event, "cache.prewarm");
  assert.equal(traces[0].reason, "startup");
  assert.equal(typeof traces[0].elapsedMs, "number");
}

// Case 3: custom prompt via env.
{
  let lastPrompt;
  const runPi = async (p) => { lastPrompt = p; };
  const cap = captureLogger();
  const pre = createPrewarmer({ runPi, env: { PI_MOM_PREWARM_PROMPT: "warmup" }, log: cap.log, warn: cap.warn });
  await pre.start().started;
  assert.equal(lastPrompt, "warmup");
}

// Case 4: runPi rejects → emits cache.prewarm_failed, no throw.
{
  const runPi = async () => { throw new Error("boom"); };
  const cap = captureLogger();
  const pre = createPrewarmer({ runPi, env: {}, log: cap.log, warn: cap.warn });
  await pre.start().started; // must not reject
  const traces = cap.parse(cap.entries.warn);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].event, "cache.prewarm_failed");
  assert.equal(traces[0].error, "boom");
}

// Case 5: PI_MOM_PREWARM_INTERVAL_MS > 0 → schedules a setInterval that fires warmups.
{
  let calls = 0;
  const runPi = async () => { calls += 1; };
  const scheduled = [];
  let intervalId = 0;
  const fakeSetInterval = (fn, ms) => {
    const id = ++intervalId;
    scheduled.push({ id, fn, ms });
    return { id, unref: () => {} };
  };
  const cleared = [];
  const fakeClearInterval = (handle) => cleared.push(handle?.id);

  const cap = captureLogger();
  const pre = createPrewarmer({
    runPi,
    setIntervalFn: fakeSetInterval,
    clearIntervalFn: fakeClearInterval,
    env: { PI_MOM_PREWARM_INTERVAL_MS: "240000" },
    log: cap.log,
    warn: cap.warn,
  });

  const handle = pre.start();
  await handle.started;
  assert.equal(calls, 1, "startup warmup ran");
  assert.equal(scheduled.length, 1, "one setInterval scheduled");
  assert.equal(scheduled[0].ms, 240000, "interval passed through verbatim");

  // Simulate the timer firing once.
  await scheduled[0].fn();
  // The fn calls warmOnce("scheduled") but does not await; give the microtask a tick.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2, "scheduled warmup also ran");

  handle.stop();
  assert.deepEqual(cleared, [scheduled[0].id], "stop clears the interval");
}

// Case 6: config object is surfaced for diagnostics.
{
  const pre = createPrewarmer({
    runPi: async () => {},
    env: { PI_MOM_PREWARM_ENABLED: "true", PI_MOM_PREWARM_INTERVAL_MS: "60000", PI_MOM_PREWARM_PROMPT: "warmup" },
  });
  assert.deepEqual(pre.config, { enabled: true, intervalMs: 60000, prompt: "warmup" });
}

// Case 7: missing runPi throws at construction (programmer error, not a runtime path).
{
  assert.throws(() => createPrewarmer({}), /runPi/);
}

console.log("cache-prewarm tests passed");
