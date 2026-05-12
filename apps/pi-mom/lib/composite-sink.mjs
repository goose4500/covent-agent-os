// Stage 8 — Composite sink. Fans every Pi AgentEvent out to multiple sinks
// (typically slack-sink for the chat-stream + canvas-sink for the canvas
// mirror). Each sink runs independently; an error in one does not block
// the others. pi-sdk-runner only knows about a single `sink` parameter,
// so we wrap N sinks into a single {start, handle, stop} shape.

export function createCompositeSink(sinks = []) {
  const list = Array.isArray(sinks) ? sinks.filter(Boolean) : [];

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
    for (const sink of list) {
      if (typeof sink.handle !== "function") continue;
      try { sink.handle(evt); } catch { /* never let one sink poison another */ }
    }
  }

  async function stop(opts) {
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

  return { start, handle, stop, sinks: list };
}
