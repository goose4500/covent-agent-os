# ADR 0012: pi-mom production hardening — theme contract, canvas retry semantics, channel gate removal, and plan card wrapping

Date: 2026-05-16
Status: accepted
Related: PR #120 (NOOP_THEME + canvas retry), PR #117 (channel gate removal), PR #119 (plan card), ADR 0007 (Polaris assistant surface)

## Context

After the Polaris Slack bridge reached a production-stable state (Foundation v2, 2026-05-12), two classes of error appeared consistently in Railway logs on every Pi-backed turn:

### Error class 1 — `MCP initialization failed` (every session)

```
MCP initialization failed: TypeError: ui.theme.fg is not a function
```

The pi-mcp-adapter extension (`pi-mcp-adapter@2.6.1`) calls `ui.theme.fg("accent", text)` inside `updateStatusBar()` on every session-initialization path. The guard is:

```js
// pi-mcp-adapter/init.ts
const ui = ctx.hasUI ? ctx.ui : undefined;
if (!ui) return;
ui.setStatus("mcp", ui.theme.fg("accent", `MCP: ${connectedCount}/${total} servers`));
```

The guard passes because `ctx.hasUI` is `true` — the Slack bridge passes a full `uiContext` to every Pi session via `session.bindExtensions({ uiContext })`. However, the `NOOP_THEME` stub in `apps/pi-mom/lib/slack-ui-context.mjs` was:

```js
const NOOP_THEME = Object.freeze({ name: "slack" });
```

The Pi SDK's `Theme` class defines 13 methods: `fg`, `bg`, `bold`, `italic`, `underline`, `inverse`, `strikethrough`, `getFgAnsi`, `getBgAnsi`, `getColorMode`, `getThinkingBorderColor`, `getBashModeBorderColor`, and a `name` property. The stub implemented only `name`. Any extension that calls any other method crashed at session init.

The consequence was that every Pi session initialized with zero MCP servers connected. The `mcp` tool was loaded but its backing servers silently failed to start. The model could call the tool but every invocation returned an error.

### Error class 2 — `subagent_canvas.replace_failed` × 3 (on canvas state failure)

When a subagent canvas sidecar encountered a hard Slack API error (`canvas_editing_failed`, `not_found`, `invalid_canvas`), the `flushChild` method in `apps/pi-mom/lib/subagent-canvas-sidecar-sink.mjs` traced the error but left `child.disabled = false`. The sink has three flush paths that all fire independently:

1. The `setInterval` timer (every ~5 seconds while the agent runs)
2. `processPayload` final flush when the agent stream ends
3. `stop()` final flush on session teardown

With `disabled = false` still set after a hard error, all three paths independently attempted `canvases.edit` on the same broken canvas. Each attempt generated the same `canvas_editing_failed` error. Three redundant Slack API calls, three trace events, zero chance of recovery.

The retry logic only short-circuited on `ratelimited` errors:

```js
} catch (err) {
  if (err?.data?.error === "ratelimited") {
    // schedule retry
  } else {
    // trace and fall through — child.disabled stays false
  }
}
```

### Operational context — channel gate

The channel allowlist (`isAllowedChannel()` in `index.mjs`) was introduced as a safety rail during initial development: only mentions in explicitly whitelisted channel IDs would trigger Pi. The guard was conditioned on `SLACK_ALLOWED_CHANNEL_ID(S)` env vars or overridden by `PI_MOM_ALLOW_ANY_CHANNEL=true`.

In practice:
- The Railway production service always had `PI_MOM_ALLOW_ANY_CHANNEL=true` set. The allowlist was never active in production.
- The guard created user confusion: Polaris was installed in every workspace channel but silently ignored `@`-mentions outside the two originally whitelisted IDs.
- The real access boundary is at the Slack app level — Polaris only responds to channels it has been invited to. An allowlist in application code duplicated a constraint the Slack platform already enforces, with no corresponding safety value in production.
- The `PI_MOM_ALLOW_ANY_CHANNEL` override name implied the restrictive case was the default, when in fact the restrictive case had never shipped to production.

### Operational context — Slack stream plan card

The Slack Streaming API uses `task_display_mode` to decide how tool invocations are rendered in the agent UI surface. When `planTitle` is omitted from the sink:

- Slack renders each `tool_execution_*` event as a standalone top-level timeline item.
- A multi-tool turn (e.g., file read → bash → canvas write) produces 3–6 disconnected timeline cards with no grouping.

When `planTitle` is set:

- Slack enters `task_display_mode="plan"` and wraps the entire tool chain for that turn under a single named agent session card.
- Users see one collapsed card ("Covent Pi agent session") that can be expanded, not a waterfall of individual tool cards.

The plan title was intentionally left unset in an earlier iteration to let Pi determine its own rendering per turn. In practice, Pi does not set it — the SDK hands that responsibility to the bridge.

## Decisions

### Decision 1: The Slack UI context's theme stub must fully implement the Pi SDK's `Theme` interface

The `ExtensionUIContext.theme` field typed as `Theme` is read by any extension that formats status-bar text. The contract is structural: any extension may call any `Theme` method. A partial stub that omits some methods is a latent crash waiting for the next extension version to call a method the stub doesn't have.

The correct approach for a headless Slack context that has no terminal:

- Implement every `Theme` method as a pass-through that returns the text argument unchanged.
- `fg(color, text) => String(text ?? "")` — color codes have no meaning in a Slack message.
- `getColorMode() => "truecolor"` — a safe non-null return that extensions can branch on.
- `getThinkingBorderColor()` and `getBashModeBorderColor()` return `(str) => String(str ?? "")` — they return a formatter function, not a string.

The fixed `NOOP_THEME` implements all 13 interface members and is `Object.freeze`-d to prevent accidental mutation.

```js
const NOOP_THEME = Object.freeze({
  name: "slack",
  fg: (_color, text) => String(text ?? ""),
  bg: (_color, text) => String(text ?? ""),
  bold: (text) => String(text ?? ""),
  italic: (text) => String(text ?? ""),
  underline: (text) => String(text ?? ""),
  inverse: (text) => String(text ?? ""),
  strikethrough: (text) => String(text ?? ""),
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => (str) => String(str ?? ""),
  getBashModeBorderColor: () => (str) => String(str ?? ""),
});
```

Any future upgrade to `pi-mcp-adapter` or any other extension that calls a new `Theme` method will work without modification because the pass-through contract covers the full interface.

### Decision 2: Hard canvas API errors permanently disable the sidecar child — no retry

`canvas_editing_failed` is Slack's signal that the canvas cannot be edited. The three known causes — the canvas was deleted, the canvas is locked by another active editor, or the canvas entered a bad internal state — are all non-transient. A retry will not fix them. The only correct response is to stop writing to that canvas for the lifetime of the session.

The retry logic gate now includes a hard-error branch:

```js
} else {
  const code = err?.data?.error || err?.code;
  traceSoft("subagent_canvas.replace_failed", { canvasId, agent, index, error: code || err?.message });
  if (code === "canvas_editing_failed" || code === "not_found" || code === "invalid_canvas") {
    child.disabled = true;
  }
}
```

`child.disabled = true` is checked at the top of `flushChild` and by all three flush paths (timer, `processPayload`, `stop()`). Once disabled, the child generates no further Slack API calls regardless of how many flush triggers fire.

The `traceSoft` event is still emitted once so the broken canvas is visible in logs; it is not emitted on subsequent skips, preventing log noise.

### Decision 3: Remove the application-layer channel allowlist

The `isAllowedChannel()` function and all dependent env vars (`SLACK_ALLOWED_CHANNEL_ID`, `SLACK_ALLOWED_CHANNEL_IDS`, `PI_MOM_ALLOW_ANY_CHANNEL`) are removed from the codebase. The access boundary is the Slack platform's channel membership check — Polaris only receives events from channels it has been invited to.

Reasons the application-layer gate is removed rather than simplified:

1. **It was never active in production.** `PI_MOM_ALLOW_ANY_CHANNEL=true` was always set on Railway.
2. **It created a gap between expectation and behavior.** Workspace members who see Polaris in a channel expect it to respond. Silent ignoring with no feedback is a worse UX than either responding or posting an error.
3. **It duplicated a Slack platform constraint.** Slack only delivers `app_mention` events to the app when the bot is a member of the channel. App membership is the correct enforcement point.
4. **The gate logic branched between `app_mention` and DM/assistant surfaces.** DMs and the Polaris assistant surface already bypassed the gate. That asymmetry was a maintenance surface that never needed to exist.

The startup guard that called `process.exit(1)` when no channel IDs were configured in `pi` mode is also removed. A process exit keyed on a missing env var that was always overridden is dead code.

### Decision 4: Always set a plan title on Pi-backed Slack stream turns

The `planTitle` passed to `createSlackSink` is set unconditionally for every Pi turn:

```js
import { buildSlackSessionPlanTitle } from "./lib/slack-session-plan.mjs";

const slackSink = createSlackSink({
  // …
  planTitle: buildSlackSessionPlanTitle(),
});
```

`buildSlackSessionPlanTitle` reads `PI_MOM_PLAN_TITLE` from the environment and falls back to `"Covent Pi agent session"`. The plan title is **bridge-owned** — it does not include user message text, thread text, or tool names. This is a deliberate security boundary: untrusted Slack content must not flow into Slack stream metadata.

The env var override is available for operators who want a custom card label (e.g., a staging vs. production label) without a code change.

## Consequences

### Immediate

- MCP servers initialize successfully on every Pi session. The `mcp` tool is now backed by live server connections from turn one.
- Subagent canvas sidecars stop spamming Slack's API and Railway logs when a canvas enters a bad state. One trace event per broken canvas, then silence.
- Polaris responds to `@`-mentions in any workspace channel it has been invited to — no channel IDs to configure or maintain.
- Pi-backed turns render as a single collapsed agent session card in the Slack thread, not a waterfall of per-tool timeline items.

### Ongoing

- **Theme interface drift risk**: If the Pi SDK adds new `Theme` methods that return non-string types (e.g., a `Promise`), the pass-through stubs will return the wrong type. The fix is to update the stubs to match. The test file `test-slack-ui-context.mjs` validates the stub shape against the live SDK types and should catch this at CI time.
- **Canvas state recovery**: The hard-error path sets `child.disabled = true` for the session. If a canvas is temporarily locked and becomes editable again mid-session, the sidecar will not recover. This is acceptable — session lifetimes are short, and a new turn creates a new session.
- **Channel gate bypass**: Removing the application-layer gate means any future need to restrict Polaris to a subset of channels must be expressed through Slack app membership (uninvite the bot from restricted channels), not through env vars. This is the correct mechanism.
- **`PI_MOM_ALLOW_ANY_CHANNEL` on Railway**: The env var remains set on the Railway service as a no-op. It can be cleared on the next routine env cleanup pass; leaving it causes no harm.

## Alternatives considered

**Patch the theme stub to only add `fg` and `bg`**: Rejected. The next extension update could call any other `Theme` method (`bold`, `inverse`, `getThinkingBorderColor`, etc.) with the same crash profile. Implementing the full interface now is strictly cheaper than playing whack-a-mole with each new extension release.

**Retry the broken canvas with exponential backoff**: Rejected for `canvas_editing_failed`. The error is Slack's hard signal that the canvas cannot be edited — exponential backoff cannot fix a deleted canvas. Rate-limit errors (`ratelimited`) already use a scheduled retry; the distinction between retriable and non-retriable errors is now explicit in the code.

**Keep `isAllowedChannel()` as an opt-in guard activated by env var**: Rejected. An opt-in guard that has never been activated in production is dead code with a maintenance cost. The Slack app's channel membership is a simpler, platform-enforced, always-on equivalent.

**Let Pi choose whether to set planTitle per turn**: Rejected. The Pi SDK does not set `planTitle` — that is a bridge-layer responsibility. Leaving it unset produces the fragmented timeline UX on every turn. The bridge has enough context to know that every Pi-backed turn is a single agent session and should be presented as such.

## Follow-ups

1. **Resolve the ADR 0007 numbering collision.** Two files share the `0007` prefix: `0007-ec2-workspace-root-for-production-pi-mom.md` and `0007-polaris-slack-assistant-surface.md`. One should be renumbered (suggested: EC2 workspace root → 0007, Polaris assistant surface → 0007b or renumber the later one to the next available slot after 0011).
2. **Clear `PI_MOM_ALLOW_ANY_CHANNEL` from the Railway `covent-pi-mom` service** on the next env cleanup pass. The var is a no-op but contributes to env noise.
3. **Add a `Theme` interface conformance check to `test-slack-ui-context.mjs`** that imports the SDK's `Theme` type and asserts each method name exists on `NOOP_THEME`. Currently the test exercises behavior but does not structurally validate against the SDK type, so interface drift would require a runtime crash to surface.
4. **Evaluate `PI_MOM_PLAN_TITLE` for per-environment labeling.** Staging and production deployments share the same card title today. Setting `PI_MOM_PLAN_TITLE=Covent Pi [staging]` on a staging service would make it unambiguous in the Slack thread which environment responded.
