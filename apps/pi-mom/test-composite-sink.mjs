import assert from "node:assert/strict";
import { createCompositeSink } from "./lib/composite-sink.mjs";

function makeFakeSink(name, { startThrows, stopThrows, handleThrows } = {}) {
  const calls = [];
  return {
    name,
    calls,
    started: false,
    stopped: false,
    async start(opts) {
      calls.push(["start", opts]);
      if (startThrows) throw new Error(`${name} start failed`);
      this.started = true;
      return { name, role: "ok" };
    },
    handle(evt) {
      calls.push(["handle", evt]);
      if (handleThrows) throw new Error(`${name} handle failed`);
    },
    async stop(opts) {
      calls.push(["stop", opts]);
      if (stopThrows) throw new Error(`${name} stop failed`);
      this.stopped = true;
      return { name, streamedChars: 42 };
    },
  };
}

// Case 1: start fans out to every sink in order.
{
  const a = makeFakeSink("a");
  const b = makeFakeSink("b");
  const composite = createCompositeSink([a, b]);
  const results = await composite.start({ initialText: "x" });
  assert.deepEqual(results, [{ name: "a", role: "ok" }, { name: "b", role: "ok" }]);
  assert.deepEqual(a.calls[0], ["start", { initialText: "x" }]);
  assert.deepEqual(b.calls[0], ["start", { initialText: "x" }]);
}

// Case 2: handle fans out without throwing even if one sink throws.
{
  const a = makeFakeSink("a");
  const b = makeFakeSink("b", { handleThrows: true });
  const c = makeFakeSink("c");
  const composite = createCompositeSink([a, b, c]);
  composite.handle({ type: "test" });
  assert.deepEqual(a.calls, [["handle", { type: "test" }]]);
  assert.deepEqual(c.calls, [["handle", { type: "test" }]], "third sink still called despite b throwing");
}

// Case 3: stop fans out and collects results; sink errors become structured entries.
{
  const a = makeFakeSink("a");
  const b = makeFakeSink("b", { stopThrows: true });
  const c = makeFakeSink("c");
  const composite = createCompositeSink([a, b, c]);
  const results = await composite.stop({ result: "ok" });
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], { name: "a", streamedChars: 42 });
  assert.ok(results[1].error instanceof Error);
  assert.match(results[1].error.message, /b stop failed/);
  assert.deepEqual(results[2], { name: "c", streamedChars: 42 });
}

// Case 4: start errors collected per sink; composite still resolves.
{
  const a = makeFakeSink("a", { startThrows: true });
  const b = makeFakeSink("b");
  const composite = createCompositeSink([a, b]);
  const results = await composite.start({});
  assert.ok(results[0].error instanceof Error);
  assert.deepEqual(results[1], { name: "b", role: "ok" });
}

// Case 5: empty + null filtering works.
{
  const composite = createCompositeSink([null, undefined, false]);
  await composite.start({});
  composite.handle({});
  await composite.stop({});
  assert.equal(composite.sinks.length, 0);
}

// Case 6: sinks that omit a method are skipped on that op.
{
  const partial = { start: async () => "p_start" };
  const a = makeFakeSink("a");
  const composite = createCompositeSink([partial, a]);
  await composite.start({});
  composite.handle({ x: 1 });
  await composite.stop({});
  assert.equal(a.calls.filter((c) => c[0] === "handle").length, 1);
  assert.equal(a.calls.filter((c) => c[0] === "stop").length, 1);
}

console.log("composite-sink tests passed");
