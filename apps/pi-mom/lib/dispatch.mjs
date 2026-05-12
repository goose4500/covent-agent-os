// Surface-aware Slack dispatcher. Both the legacy `app.event('app_mention')`
// adapter and the Bolt 4.7 `Assistant` container call `dispatchToAction()`,
// which normalizes inputs and delegates to `handleRequest()` in index.mjs.
//
// Surfaces:
//   "app_mention"     — @Covent-Agent in a channel or thread
//   "direct_message"  — 1:1 IM with the bot (legacy DM path)
//   "assistant"       — Bolt 4.7 Assistant container in the Assistant chat tab
//
// The dispatcher is DI-friendly (handleRequest, trace) so the unit tests can
// fake handleRequest and assert routing decisions without booting Bolt.

export function createDispatcher({ handleRequest, trace = () => {} } = {}) {
  if (typeof handleRequest !== "function") {
    throw new Error("createDispatcher requires { handleRequest } function");
  }

  async function dispatchToAction({ surface, event, client, utilities } = {}) {
    if (!surface) throw new Error("dispatchToAction requires surface");
    if (!event) throw new Error("dispatchToAction requires event");
    if (!client) throw new Error("dispatchToAction requires client");

    const channel = event?.channel || event?.assistant_thread?.channel_id;
    trace("dispatch.start", {
      surface,
      channel,
      threadTs: event?.thread_ts || event?.ts,
      hasUtilities: Boolean(utilities),
    });

    const setStatus = utilities?.setStatus;
    let statusOpened = false;

    if (surface === "assistant" && typeof setStatus === "function") {
      try {
        await setStatus("is thinking…");
        statusOpened = true;
      } catch {
        // setStatus is best-effort; failures must not block routing.
      }
    }

    try {
      await handleRequest({ client, event, mode: surface });
    } finally {
      if (statusOpened) {
        try {
          await setStatus("");
        } catch {
          // ignore
        }
      }
      trace("dispatch.end", { surface });
    }
  }

  return { dispatchToAction };
}
