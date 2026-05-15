> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Block Kit UX: actionable App Home cockpit + final-message actions row + tiny internal DSL

**Type**: `ux`
**Source**: 2026-05-12 first-principles audit (`docs/research/2026-05-12/audit-24h.md`; Block Kit deep-dive findings)
**Surface**: new `apps/pi-mom/lib/blocks.mjs`, `apps/pi-mom/lib/home-view.mjs`, `apps/pi-mom/lib/slack-sink.mjs`, `apps/pi-mom/index.mjs`
**Risk**: Medium — first user-visible UX change since Stage 7. Adds new interactive paths (overflow menu, final-message buttons). Each new action_id needs a handler.
**Expected diff**: ~60 LOC added in new `lib/blocks.mjs`, ~30 LOC reshaped in `home-view.mjs`, ~50 LOC added in `slack-sink.stop()`, ~40 LOC of new Bolt action handlers in `index.mjs`.

## Context

The current Block Kit usage in pi-mom is correct but under-leveraged. `home-view.mjs:28-34` collapses every pending approval into one shared `section` with a bullet list — readable but inert; the user has to context-switch into the Slack thread to act. `slack-sink.mjs` ends every Pi run with a plain text message; there's no slot for "Re-run / Open canvas / File Linear" affordances even though those are the next-step actions users want 80%+ of the time.

This issue ships three Block Kit upgrades together because they share a tiny internal DSL (`lib/blocks.mjs`) that removes the JSON boilerplate currently repeated across `home-view.mjs` and `slack-ui-context.mjs`.

## Why

From the Block Kit audit: *"Under-using Block Kit on streaming + Home; one framework switch worth making, two not worth making."* The framework switch worth making is a 60-LOC internal DSL (not jsx-slack/phelia/slack-blocks-react — overkill for this scale). The two under-leveraged surfaces are App Home (turn the cockpit from snapshot to actionable) and the final streamed message (close the loop on every successful run).

## Sub-tasks

### 1. Add tiny internal Block Kit DSL (`lib/blocks.mjs`)
- [ ] Create `apps/pi-mom/lib/blocks.mjs` exporting ~10 composable helpers:
  ```js
  export const text  = (t, opts) => ({ type: "plain_text", text: String(t), emoji: true, ...opts });
  export const mrkdwn = (t)      => ({ type: "mrkdwn", text: String(t) });
  export const header = (t)      => ({ type: "header", text: text(t) });
  export const divider = ()      => ({ type: "divider" });
  export const section = (md, accessory) => ({ type: "section", text: mrkdwn(md), ...(accessory ? { accessory } : {}) });
  export const context = (...md) => ({ type: "context", elements: md.map(mrkdwn) });
  export const actions = (...elements) => ({ type: "actions", elements });
  export const button = (action_id, label, opts = {}) => ({ type: "button", action_id, text: text(label), ...opts });
  export const overflow = (action_id, options) => ({ type: "overflow", action_id, options: options.map(o => ({ text: text(o.label), value: o.value })) });
  export const staticSelect = (action_id, placeholder, options) => ({ type: "static_select", action_id, placeholder: text(placeholder), options: options.map(o => ({ text: text(o.label), value: o.value })) });
  ```
- [ ] Zero new dependencies, zero runtime cost, no JSX, no React.
- [ ] Add a header comment that explicitly says: **"This is intentionally a tiny DSL. Do not migrate to jsx-slack/phelia/slack-blocks-react — those are overkill for a 2-file Block Kit surface. Also: do not convert `confirm`/`select`/`input` approval messages to modals; the current async-message pattern is correct because tool callbacks have no `trigger_id` (see `slack-ui-context.mjs:5-14`)."**
- [ ] Add `apps/pi-mom/test-blocks.mjs` smoke test: assert each helper returns the expected JSON shape; assert composition (`section(md, button(...))` produces a valid accessory'd section).
- [ ] Add `bun test-blocks.mjs` to the `check` script in `apps/pi-mom/package.json`.

### 2. App Home: per-approval `section` + `overflow` accessory (actionable cockpit)
- [ ] Refactor `apps/pi-mom/lib/home-view.mjs:28-34` so each pending approval renders as **its own `section` block** with `accessory: overflow(...)`, instead of one shared bullet list.
- [ ] Each `overflow` exposes three options: `Approve` (value: `approve`), `Deny` (value: `deny`), `Open thread` (value: `open`). The `value` field carries the `approvalId` so the action handler can route without parsing.
- [ ] Action_id convention: `pi_home_approval_overflow` (one global handler, not one per row).
- [ ] Add `app.action("pi_home_approval_overflow", ...)` handler in `apps/pi-mom/index.mjs`:
  - On `approve` / `deny`: look up `pendingApprovals.get(approvalId)`, call the resolver from `slack-ui-context.mjs` (`resolveConfirmAction` shape). Slack-thread post + Home republish flow inherits from the existing approval flow.
  - On `open`: post an ephemeral message with the Slack permalink to the source thread (via `chat.getPermalink({ channel, message_ts: entry.threadTs })`).
- [ ] Cap stays `APPROVAL_CAP = 6` (`home-view.mjs:12`).
- [ ] Add `header` block at the top of the Home view, plus a `context` block under the approvals list ("Tip: tap the ⋯ menu on any row to act without leaving Home."). Use the new DSL.
- [ ] **Optional polish** (defer if scope grows): a `actions` block at the top of Home with quick-start route buttons (`New spec`, `Create Linear issue`, `Summarize last thread`) — each posts a templated message into the user's DM with the bot, which routes through the existing `direct_message` dispatcher. This is the single largest cockpit upgrade beyond approvals; see Block Kit audit Q3.
- [ ] Update `apps/pi-mom/test-home-view.mjs`: assert per-approval section structure, assert `overflow` accessory present, assert action_id is the global `pi_home_approval_overflow`.

### 3. Final streamed message: `chat.update` with trailing `context` + `actions` row
- [ ] In `apps/pi-mom/lib/slack-sink.mjs` `stop()` (after `stream.stopStream()`), call `client.chat.update({channel, ts: streamTs, text: existingText, blocks: [...]})` with:
  1. `section(mrkdwn(existingText))` — keep the body so notifications and screen readers still work.
  2. `context(mrkdwn(\`route \\\`${routeKey}\\\` · ${Math.round(durationMs/100)/10}s · ${toolCount} tools · req \\\`${requestId}\\\`\`))` — the meta strip.
  3. `actions(...)` with:
     - `button("pi_run_rerun", "Re-run", { value: requestId })` — re-fires the original `prompt` (look up by `requestId` from the in-memory session map).
     - `button("pi_run_open_canvas", "Open canvas", { url: canvasUrl })` — Slack's url-button, no action handler needed (just include `url`, omit `action_id` handler).
     - `button("pi_run_file_linear", "File Linear", { value: requestId })` — re-dispatches the same prompt through the `linear` route.
- [ ] **Fold the canvas-link post into the actions row** — delete the standalone `chat.postMessage("📄 Streaming this spec into a canvas → ...")` at `apps/pi-mom/index.mjs:393-403`. The canvas URL now lives on the `Open canvas` button.
- [ ] Only show buttons whose action is meaningful:
  - `Open canvas` only when `canvasSink?.url` exists (i.e. `spec:` route).
  - `File Linear` only when the route is not already `linear` and `LINEAR_API_KEY` is set.
  - `Re-run` always (cheap; just re-fires the prompt).
- [ ] Add three action handlers in `index.mjs`:
  - `app.action("pi_run_rerun")` — look up `(requestId, threadTs, prompt)` from the in-memory map populated by `runPiWithSlackStream`; re-dispatch through `handleRequest`. If the map entry is gone (process restart), post an ephemeral "Re-run unavailable — original request expired" and ack.
  - `app.action("pi_run_file_linear")` — same lookup, then dispatch with `routeKey: "linear"` and the original `text` as the body.
  - `Open canvas` needs no handler (url-button).
- [ ] Update `apps/pi-mom/test-slack-sink.mjs` to assert the `chat.update` is called on `stop()` with the correct block structure when `canvasUrl` is present and when it's absent.

## Acceptance criteria

- [ ] `bun run check` green (secret-scan + validators + 14 pi-mom suites — new `test-blocks.mjs` brings the count to 14 + `tsc --noEmit`).
- [ ] Visual verification on `covent-pi-mom-v2`:
  - App Home: each pending approval is its own row with a working ⋯ menu (Approve/Deny/Open thread).
  - Approval flow: tapping `Approve` in App Home resolves the in-thread approval without the user opening the thread.
  - End of a successful `spec:` run: a single final message with the body, a meta strip, and three buttons (Re-run / Open canvas / File Linear). No separate canvas-link post.
  - End of a successful `linear:` run: body + meta strip + Re-run only (Open canvas hidden because no canvas; File Linear hidden because already linear).
  - Tapping `Re-run` re-fires the prompt and produces a new run-card.
- [ ] No visual regression on plain-text routes (`help`, `status`) — they still use plain `text` postMessage.

## Out of scope

- Migrating `formatHelp` / `formatStatus` / approval modals from `mrkdwn` to `rich_text` — minimal user-visible win, triples JSON size, the installed SDK doesn't surface `rich_text` discriminated types prominently.
- Converting confirm/select/input from interactive thread messages to full modals — async tool callbacks have no `trigger_id`, so this can't work (see `slack-ui-context.mjs:5-14`).
- Pulling in jsx-slack / phelia / slack-blocks-react — overshoot for this scale.
- Quick-start route-button row at the top of App Home — flagged as optional polish in sub-task 2; defer to its own issue if it grows.

## References

- 24h audit: `docs/research/2026-05-12/audit-24h.md`
- Block Kit audit verdict (in audit transcript): *"Under-using Block Kit on streaming + Home; one framework switch worth making, two not worth making."*
- `apps/pi-mom/lib/slack-ui-context.mjs:5-14` — header comment on why approval messages are not modals.
- Slack Block Kit reference: `node_modules/@slack/types/` (block + element types).
- Bolt `chat.update`: `node_modules/@slack/web-api/dist/types/methods.d.ts` (`ChatUpdateArguments`).
- Slack canvas URL-button pattern: standard Block Kit `button` element with `url` field, no action handler needed.

## Sequencing

- Sub-task 1 (DSL) **must land first**.
- Sub-tasks 2 and 3 can be done in parallel after the DSL exists.
- Could be one PR with three commits, or three small PRs — author's call.
