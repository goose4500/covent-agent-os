// Stage 8 — Composite sink. Fans every Pi AgentEvent out to multiple sinks
// (typically slack-sink for the chat-stream + canvas-sink for the canvas
// mirror). Each sink runs independently; an error in one does not block
// the others. pi-sdk-runner only knows about a single `sink` parameter,
// so we wrap N sinks into a single {start, handle, stop} shape.
//
// addSink/removeSink allow tools (e.g. slack_canvas_start) to attach a
// sink to the live event fan partway through a turn. New sinks receive
// every subsequent event; events already dispatched are not replayed.

export function createCompositeSink(sinks = []) {
  const list = Array.isArray(sinks) ? sinks.filter(Boolean) : [];
  let stopped = false;

  async function start(opts) {
    const results = [];
    for (const sink of list) {
      if (typeof sink.start !== "function") {
        results.push(undefined);
        continue;
      }
      try {
        results.push(await sink.start(opts));
      } catch (err) {
        results.push({ error: err });
      }
    }
    return results;
  }

  function handle(evt) {
    // Snapshot so a sink added/removed mid-iteration doesn't perturb the
    // current dispatch loop.
    const snapshot = [...list];
    for (const sink of snapshot) {
      if (typeof sink.handle !== "function") continue;
      try { sink.handle(evt); } catch { /* never let one sink poison another */ }
    }
  }

  async function stop(opts) {
    stopped = true;
    const results = [];
    for (const sink of list) {
      if (typeof sink.stop !== "function") {
        results.push(undefined);
        continue;
      }
      try {
        results.push(await sink.stop(opts));
      } catch (err) {
        results.push({ error: err });
      }
    }
    return results;
  }

  function addSink(sink) {
    if (!sink || stopped) return false;
    if (list.includes(sink)) return false;
    list.push(sink);
    return true;
  }

  function removeSink(sink) {
    const i = list.indexOf(sink);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }

  return { start, handle, stop, addSink, removeSink, sinks: list };
}
