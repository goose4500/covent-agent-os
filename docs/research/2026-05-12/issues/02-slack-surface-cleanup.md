# Slack surface cleanup: drop SDK-duplicate timers, monkey-patches, redundant filters

**Type**: `cleanup`
**Source**: 2026-05-12 first-principles audit (`docs/research/2026-05-12/audit-24h.md`; Slack surface deep-dive findings)
**Surface**: `apps/pi-mom/index.mjs`, `apps/pi-mom/lib/slack-sink.mjs`, `apps/pi-mom/lib/canvas-sink.mjs`, `apps/pi-mom/lib/slack-ui-context.mjs`, `apps/pi-mom/lib/dispatch.mjs`
**Risk**: Low — no user-visible behavior change. Each sub-task replaces a hand-rolled defensive code path with the platform-native equivalent.
**Expected diff**: ~40 LOC deleted, ~15 added (net ~25 LOC out).

## Context

The Stage 5–7 Slack wiring (slack-sink streaming, canvas-sink mirror, App Home cockpit, ExtensionUIContext → modals) ships correctly but carries hand-rolled defensive code that duplicates platform behavior. Two examples: `slack-sink.mjs:142-155` adds a 200ms batch timer on top of `ChatStreamer.append`'s built-in `buffer_size: 256` auto-flush; `index.mjs:496-507` monkey-patches `pendingApprovals.set/delete` to trigger App Home republishes when Bolt middleware can do the same thing without prototype mutation.

This issue collapses those duplications. The genuine workarounds (rotation cap in `slack-sink`, canvas debounce, per-user App Home push, channel allowlist, redaction) stay.

## Why

From the Slack surface audit: *"Two layers we can collapse, one true bug (double-DM), the rest is idiomatic for the platform's missing pieces."* This issue ships the collapsible layers and the defensive guard for the implicit-Bolt-ordering near-bug, plus one wrong comment in `canvas-sink.mjs`.

## Sub-tasks

### 1. Drop the 200ms text-batching timer in `slack-sink`
- [ ] In `apps/pi-mom/lib/slack-sink.mjs` (currently lines 142-155), delete the per-200ms `setTimeout` flush loop on top of `stream.append`.
- [ ] Call `stream.append(delta)` directly on each `text_delta` event; the SDK auto-flushes at `buffer_size` (default 256 chars).
- [ ] If finer control needed, pass `client.chatStream({buffer_size: <n>})` once in `start()`. Verify against `node_modules/@slack/web-api/dist/chat-stream.js:69-93` (`ChatStreamer.append` buffer + auto-flush) and `node_modules/@slack/web-api/dist/types/methods.d.ts` (`StartStreamArguments.buffer_size`).
- [ ] **Keep the rotation cap** (`slack-sink.mjs:29` 9000-char per-message ceiling) — `ChatStreamer` is single-stream by construction (one `streamTs` baked in at line 124 of `chat-stream.js`), so rotation has to live above the SDK.
- [ ] **Keep the heartbeat** — it serves the assistant `setStatus` pump (see sub-task 6) and the canvas-sink flush trigger.

### 2. Drop the redundant `message.bot_id` check in the DM handler
- [ ] In `apps/pi-mom/index.mjs:744`, remove `if (message.subtype || message.bot_id) return;`'s `|| message.bot_id` clause. Keep the `subtype` check (catches `channel_join`/`message_changed`/etc.).
- [ ] Justification: Bolt registers `ignoreSelf` middleware by default (`node_modules/@slack/bolt/dist/App.js:196` → `node_modules/@slack/bolt/dist/middleware/builtin.js:257-279`), which already drops `subtype === "bot_message"` from the bot itself.

### 3. Add the missing assistant-thread guard to the DM handler
- [ ] In `apps/pi-mom/index.mjs:743`, add `if (message.thread_ts) return;` as the first line of the handler.
- [ ] Justification: Bolt's `Assistant.getMiddleware` (`@slack/bolt/dist/Assistant.js:35-42`, registered via `app.assistant(...)` in `App.js:259-263`) processes assistant-thread payloads inline without calling `args.next()`, which prevents the global listener fanout. So `app.message` does NOT currently fire for assistant-tab messages. But this is an **implicit** guarantee that depends on internal Bolt middleware ordering — making it explicit prevents a regression if Bolt ever changes that behavior.

### 4. Replace `pendingApprovals.set/delete` monkey-patch with resolver-side republish
- [ ] In `apps/pi-mom/index.mjs:496-507`, delete the four lines that override `pendingApprovals.set` and `pendingApprovals.delete`.
- [ ] In `apps/pi-mom/lib/slack-ui-context.mjs:417-451` (`_resolvePendingFromButton` / `resolveConfirmAction` / `resolveSelectAction` / `resolveInputSubmission` / `resolveInputCancel`), accept an optional `onAfterResolve()` callback. After the helper calls `pendingApprovals.delete(approvalId)`, invoke `onAfterResolve?.()`.
- [ ] In `apps/pi-mom/index.mjs`, pass `() => publishHomeForAllWatched(slackClient)` as the callback when wiring the resolvers (action/view handlers at lines 676-726).
- [ ] Likewise, when **adding** to `pendingApprovals` (every `createSlackUIContext` caller path in `index.mjs:373-386`), call `publishHomeForAllWatched(slackClient)` after the `pendingApprovals.set(...)` inside the helper — or expose a single `addPendingApproval(entry)` helper from `slack-ui-context.mjs` that calls both `set` and the republish callback. Either is fine; pick the smaller diff.
- [ ] Net effect: same App Home behavior (republish on state change), no Map prototype mutation.

### 5. Fix the wrong "1 op per call" comment in `canvas-sink`
- [ ] In `apps/pi-mom/lib/canvas-sink.mjs:10-12`, delete the claim "AT MOST 1 operation per call" and replace with the correct description: `canvases.edit` accepts `changes: [Change, ...Change[]]` (a non-empty array of operations per call).
- [ ] Keep the 3s / 1.5KB debounce — it's there for Tier 3 rate-limit headroom, not the per-call op count.
- [ ] **Optionally** (not required for this issue): batch multiple `insert_at_end` operations into one `canvases.edit` call when the buffer accumulates multiple discrete fragments between flushes. This is a small perf win and a noticeable simplification of `flushNow()`; defer to a follow-up if scope grows.
- [ ] Citation: `node_modules/@slack/web-api/dist/types/request/canvas.d.ts:67-70` (`changes: [Change, ...Change[]]`).

### 6. Fold the dispatcher-side `setStatus("is thinking…")` into the sink heartbeat
- [ ] In `apps/pi-mom/lib/dispatch.mjs:34-41`, delete the pre-emptive `utilities?.setStatus("is thinking…")` call.
- [ ] In `apps/pi-mom/lib/slack-sink.mjs` heartbeat path (currently around lines 164-166), pass the `setStatus` callback through and invoke it from the heartbeat. The sink already runs a periodic timer; routing the assistant-status pump through it removes the duplicate caller and ensures status reflects actual streaming activity.
- [ ] Wire `setStatus` through `runPiWithSlackStream` in `index.mjs:335` and on into `createSlackSink({..., setStatus})`.

### 7. For the `assistant` surface, hand Bolt's `sayStream` into the sink (instead of `client.chatStream`)
- [ ] When constructing the slack-sink for the assistant surface (currently `index.mjs:335-348` calls `createSlackSink({client, ...})` which calls `client.chatStream(...)`), check whether the caller is the assistant handler. If so, pass `sayStream` (provided by Bolt's `Assistant.userMessage` args) into the sink and use it instead of `client.chatStream`.
- [ ] Bolt's `createSayStream` (`node_modules/@slack/bolt/dist/context/create-say-stream.js:4-14`) pre-fills `channel`, `thread_ts`, `recipient_user_id`, `recipient_team_id` from the assistant context. This deletes the `streamArgsForEvent` / `buildStreamArgs` plumbing for the assistant surface (currently `index.mjs:319-327` + `slack-sink.mjs:70-77`).
- [ ] For `app_mention` and DM (`message.im`), keep `client.chatStream` — those surfaces don't have a pre-bound `sayStream`.

## Acceptance criteria

- [ ] `bun run check` green (secret-scan + validators + 13 pi-mom suites + `tsc --noEmit`).
- [ ] `slack-sink.mjs` test suite still passes; if the 200ms timer is referenced in test expectations, update assertions to expect SDK-driven flush (not wall-clock-driven).
- [ ] `slack-ui-context.mjs` test suite still passes after the resolver-callback refactor.
- [ ] Live canary on `covent-pi-mom-v2`: streaming, App Home cockpit update on approval, approval modals (confirm/select/input), and canvas mirror all behave identically.
- [ ] Net diff: ~25 LOC deleted.

## Out of scope

- Final-message `chat.update` with `actions` row (see issue: *Block Kit UX + actionable cockpit*).
- App Home per-approval `overflow` accessory (see same).
- Retiring `/thread-spec` (see issue: *Decisions cohort*).
- Replacing `homeWatchedUsers` Set with broadcast — Slack has no broadcast for App Home (`views.publish` takes `user_id`); current shape is correct.
- Replacing `redactSensitiveText` — Bolt/web-api only redact inbound logs (`@slack/web-api` logger), not outbound text. Hand-rolled is correct.

## References

- 24h audit: `docs/research/2026-05-12/audit-24h.md`
- Bolt source: `node_modules/@slack/bolt/dist/`
  - `App.js:196,259-263` — default middleware + `app.assistant(...)` registration
  - `Assistant.js:35-42,79-83` — assistant middleware non-`next()` behavior + `sayStream`/`setStatus`/`setSuggestedPrompts`
  - `context/create-say-stream.js:4-14` — pre-filled stream args
  - `middleware/builtin.js:257-279` — default `ignoreSelf`
- web-api source: `node_modules/@slack/web-api/dist/`
  - `chat-stream.js:69-93,124` — `ChatStreamer.append` buffer + single-stream
  - `types/request/canvas.d.ts:67-70` — `canvases.edit` accepts batched changes
