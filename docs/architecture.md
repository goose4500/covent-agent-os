# Architecture

> **Status:** post-rebuild canonical architecture as of 2026-05-12 (PR #24, merge commit `1ab169c`). Replaces the older subprocess-based shape entirely.

## What you're looking at

`covent-pi-mom` is a Slack Socket Mode bridge that runs Pi (an AI coding agent) in-process and routes each Slack mention or Assistant message through a per-Action policy file. Both Bolt 4.7's `Assistant` container and the legacy `app_mention` adapter resolve to the same `dispatchToAction` function. The same Pi session resumes across thread turns (per-thread `SessionManager`). Streaming responses use `chat.startStream`; long-form output mirrors to a standalone Slack canvas; Pi extensions emit approval modals into Slack via `ExtensionUIContext`.

## The 3-primitive foundation

```
@earendil-works/pi-coding-agent@0.74     ─►  in-process Pi agent
@slack/bolt@4.7 + @slack/web-api@7.15.2  ─►  Slack runtime + streaming + canvases
apps/pi-mom/control-plane/registry.yaml  ─►  per-route tool gating + systemPromptSuffix + approvals
```

Everything else is wiring. No subprocess. No custom run store. No bespoke chunker. No post-stream Linear guard.

## End-to-end flow

```text
Slack event (app_mention | Assistant userMessage)
  │
  ▼
Bolt receiver
  │
  ▼
adapter (assistant | app_mention) ──► dispatchToAction({surface, channel, threadTs, userId, text, ack, utilities})
  │
  ▼
action-resolver(registry.yaml) ──► {name, tools, systemPromptSuffix, approvals}
  │
  ▼
runTurn({surface, threadTs, prompt, sink, uiContext})
  │
  ├─► SessionManager.open(thread_session_map[threadTs])     ◄── per-thread Pi session resumption
  │      OR .create(repoRoot)
  │
  ├─► createAgentSession({model, sessionManager, …})
  │      .bindExtensions({uiContext: slackUI})              ◄── Pi extensions get Slack modals
  │      .setActiveToolsByName(action.tools)                ◄── per-route tool gating
  │
  ├─► session.subscribe(evt ─► sink.handle(evt))            ◄── composite-sink fans to slackSink + canvasSink
  │
  └─► session.prompt(action.suffix + userText)
                                                            
Pi events stream out:
  text_delta       ─► slack-sink batches every 200ms → chat.appendStream
                      canvas-sink debounces 3000ms → canvases.edit (spec: route)
  tool_call        ─► permission-gate may intercept → ctx.ui.confirm/select → Slack modal
  tool_call_end    ─► linear-tools may return AgentToolResult → Slack confirmation in stream
  agent_end        ─► chat.stopStream + final action chunks
```

## File tree

```
apps/pi-mom/
├── index.mjs                       (799 LOC)  bun entry; Bolt boot; both surface adapters;
│                                              app_home_opened handler; pendingApprovals Map +
│                                              wrapped set/delete that pushes Home state
├── control-plane/
│   ├── registry.yaml                          per-route Action vocabulary
│   └── registry-loader.mjs                    YAML → runtime metadata
├── lib/
│   ├── dispatch.mjs                 (58)      dispatchToAction({surface, …})
│   ├── action-resolver.mjs          (85)      parses Slack text + registry → Action
│   ├── pi-sdk-runner.mjs           (295)      createAgentSession glue; OAuth seed from PI_AUTH_JSON_B64
│   ├── pi-session.mjs               (87)      runTurn — opens session, subscribes events, pumps sink
│   ├── thread-session-map.mjs      (107)      JSON-on-disk threadTs → sessionFile path
│   ├── slack-sink.mjs              (268)      Pi events → chat.startStream/appendStream + heartbeat
│   ├── slack-ui-context.mjs        (451)      Pi ExtensionUIContext → Slack approval modals
│   ├── canvas-sink.mjs             (268)      Pi text_delta → canvases.edit (debounced) for spec: route
│   ├── composite-sink.mjs           (50)      Fan one Pi event stream → multiple sinks
│   └── home-view.mjs                (51)      App Home cockpit view builder (approvals-only)
└── test-*.mjs                                 13 bun test suites
```

`apps/pi-mom/` total ≈ 2,519 LOC after Stage 10 cleanup (was 3,310 pre-rebuild).

## Routes (from `control-plane/registry.yaml`)

| Route | tools | approvals | What it does |
|---|---|---|---|
| `plain` (no prefix) | `bash`, `read`, `grep`, `find`, `edit`, `write` | `tool` | Full default Pi toolset — bare mentions can run shell, read/write files |
| `help` | — | `none` | Hard-coded menu via `formatHelp()` |
| `status` | — | `none` | Bridge health/config via `formatStatus()` |
| `summarize` | — | `none` | Thread → decisions/questions/owners/next-actions |
| `linear` | `linear_search_issues`, `linear_create_issue`, `linear_add_comment` | `tool` | Search-first idempotency → comment-or-create |
| `agenda` | — | `none` | Thread → meeting agenda |
| `spec` | — | `none` | Thread → PRD draft; mirrors to a standalone Slack canvas |
| `bash` | `bash` | `tool` | Explicit shell; permission-gate intercepts dangerous commands |

Tool gating is enforced by the SDK's `setActiveToolsByName(action.tools)`. An empty array = `noTools: "all"` plus a `DefaultResourceLoader` with `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` — the SDK's default-deny posture.

## Both surfaces, one dispatcher

`@Covent-Agent` in a channel triggers `app.event("app_mention")`. The Assistant chat tab triggers `new Assistant({ threadStarted, userMessage })`. Both adapters call `dispatchToAction({surface, …})` so messages produce identical responses regardless of where they came from. Slack manifest scopes: `assistant:write`, `chat:write`, `im:history`, `app_mentions:read`, `channels:history`, `groups:history`, `mpim:history`, `commands`, `files:write`, `canvases:write`.

## Streaming + heartbeat

`lib/slack-sink.mjs` is the only streaming path. It:

- Batches Pi `text_delta` events every **200ms** into `chat.appendStream` chunks.
- Emits zero-width-space **heartbeats every 25s** to keep Slack's stream session alive during long thinking-level=high runs.
- **Rotates streams** before per-message char ceiling (38KB default) so single messages stay under Slack limits.
- On `agent_end`, calls `chat.stopStream` with any final action chunks.

Legacy chunker (`splitForSlackStream`) + `chat.update` fallback + `PI_OUTPUT_IDLE_MS` were all deleted in Stage 5 / Stage 10. There is no fallback path; if Slack's stream API is unavailable, the sink throws at start and a single `chat.postMessage` carries the error.

## Approval modals (Stage 6)

`lib/slack-ui-context.mjs` implements Pi's `ExtensionUIContext` (`confirm`, `select`, `input`, `notify`, `setStatus`). The `permission-gate` extension (in `extensions/permission-gate.ts`) calls `ctx.ui.select("Allow?", ["Yes","No"])` when the model tries to run `rm -rf` / `sudo` / `chmod 777` / `chown 777`. The bridge translates that into Slack interactive buttons (or `views.open` modal for `input`). A process-global `pendingApprovals` Map resolves the original promise on `view_submission` / `block_actions`.

The same `pendingApprovals` mutations push state to the App Home cockpit (`app.event("app_home_opened")` → `views.publish(buildHomeView(…))`).

## Long-form output → canvas mirror (Stage 8)

The `spec:` route mirrors its output into a standalone Slack canvas via `composite-sink([slackSink, canvasSink])`. The canvas-sink debounces `canvases.edit` every 3000ms / 1500B. Key correctness bits:

- URL format must be `https://app.slack.com/docs/{TEAM_ID}/{CANVAS_ID}` (`team_id` is required).
- `canvases.create` is called **without** `channel_id` to produce a standalone canvas; channel-attached canvases broke the URL.
- After create, two `canvases.access.set` calls grant write access to the originating user + the channel.
- The `op: "rename"` edit operation returns `invalid_arguments` from Slack; it was dropped. Streaming indicator lives in the thread message instead.

## Linear as modular custom tools

`extensions/linear-tools.ts` registers 3 tools via `pi.registerTool`. Idempotency lives in model reasoning, not in a post-stream guard.

| Tool | Purpose |
|---|---|
| `linear_search_issues` | Find existing matches before creating — duplicate prevention |
| `linear_create_issue` | Create a new issue (title, Markdown description, optional priority) |
| `linear_add_comment` | Comment on existing issue; accepts UUID or human identifier (e.g. `FE-554`) — auto-resolves via `IssueLookup` query |

The `linear:` route's `systemPromptSuffix` in registry.yaml nudges: ALWAYS call `linear_search_issues` first; if a match comes back, prefer `linear_add_comment`; only call `linear_create_issue` when no match exists. Live verified zero duplicates across 4+ canary runs into FE-554.

Shared `makeLinearCall` helper centralizes auth (`LINEAR_API_KEY`), HTTP error shaping, AbortSignal handling, and secret redaction so each `execute()` stays focused on its own variables.

## App Home cockpit (Stage 7, trimmed Stage 10)

`app.event("app_home_opened")` publishes a read-only snapshot via `views.publish`. Push-updates fire on every `pendingApprovals.set` / `pendingApprovals.delete` (wrapped via a proxy that the slack-ui-context can mutate without knowing about App Home).

Current sections after Stage 10: header + approvals block (or "No approvals waiting" placeholder). The runs/activity sections were trimmed when `runStore` was deleted; can be re-lit if/when an SDK-backed runs index is added.

## Required env vars

See [README.md § Production deploy](../README.md#production-deploy) for the canonical env var table. Highlights:

- `PI_AUTH_JSON_B64` — base64 of `~/.pi/agent/auth.json`; seeded into `/data/pi-agent/auth.json` on cold boot. Without it, the SDK can't OAuth on a fresh container fs.
- `PI_OFFLINE=1` — stops the SDK from running `npm install -g pi-web-access` at session creation.
- `PI_AGENT_DIR=/data/pi-agent` — Railway persistent volume mount; per-thread session files persist across deploys.

Removed in Stage 10 (cosmetic — new code already ignored them): `PI_COMMAND`, `PI_EXTRA_ARGS`, `PI_OUTPUT_IDLE_MS`, `PI_MOM_ALLOW_PI_TOOLS`, `PI_MOM_IMAGE_ROUTE_ENABLED`, `PI_MOM_STREAMING`, all `PI_MOM_AGENT_*`.

## Extensions

Currently wired through `pi-sdk-runner.mjs`:

| Extension | Where | What it does |
|---|---|---|
| `extensions/permission-gate.ts` | repo-local, always loaded | Intercepts `rm -rf` / `sudo` / `chmod 777` / `chown 777` via `ctx.ui.select` → Slack modal |
| `extensions/linear-tools.ts` | repo-local, always loaded | The 3 modular Linear tools |
| `extensions/env-guard.ts` | global at `~/.pi/agent/extensions/` | Blocks writes to `.env*` / `~/.secrets/**` |
| `extensions/git-checkpoint.ts` | global | Auto-commits before risky operations |

Not yet wired (tracked as follow-up): `packages/pi-ext-covent-aws` — would route `bash` execution to an EC2 operator instance via `COVENT_LANE=operator AWS_REGION=us-east-1`.

## Deploy lifecycle (canonical)

The blue-green canary pattern that shipped this rebuild. Reusable for future risky migrations — see [docs/runbooks/foundation-v2-cutover-2026-05-12.md](runbooks/foundation-v2-cutover-2026-05-12.md) for the step-by-step.

1. **Parallel Railway service** (`covent-pi-mom-v2`) auto-deploys from the work branch; production keeps running old code from `main`.
2. **Live canary on v2** — exercise every route end-to-end before unlocking the next stage.
3. **Pre-merge env mirror** — `railway variables --service v2 --kv | grep ^(NEEDED_KEYS) | while … railway variables --service prod --set "$k=$v"` (values never echo).
4. **Down the canary before merge** — prevents Socket Mode split-brain when both services hold the same Slack tokens.
5. **Merge with `--merge`** — preserves stage history.
6. **Watch Railway** via `railway status --json | jq …` for `BUILDING → DEPLOYING → SUCCESS`.
7. **Boot-signature verification + live canary on prod** — confirm new code's expected lines appear; run a tool call that returns container-identifying output (hostname) to prove it's actually prod.
8. **Keep canary `down` (not deleted) for ~24h** as a hot rollback target. `railway up --service covent-pi-mom-v2` restores it within 2 min.

## What was killed in the rebuild

| What | Why |
|---|---|
| `spawn("pi", …)` subprocess + stdout-polling + idle detection + ENOENT trap | SDK is in-process — entire 100+ LOC of subprocess plumbing gone |
| `lib/agent-run-card.mjs` + `lib/agent-run-store.mjs` + `lib/agent-runners.mjs` + `lib/slack-canvas.mjs` | Agent Run Card / Block Kit Start-Cancel pattern is pre-SDK; replaced by streaming task chunks |
| `lib/openai-image-client.mjs` (313 LOC) | Image generation removed entirely (Stage 9 killed; low value) |
| `lib/linear-idempotency.mjs` (62 LOC) | Replaced by modular Linear tools + idempotency in model reasoning |
| `splitForSlackStream` + `STREAM_BUFFER_CHARS` + `PI_OUTPUT_IDLE_MS` + `chat.update` fallback | slack-sink batches by time-window; legacy chunker was dead code |
| `image:`, `digest:`, `escalation:` routes | Low-value; user decision |
| `agent:` route + `uictx:` Stage-6 dev probe | Stage 10 cleanup |

## Related

- [`README.md`](../README.md) — top-level overview + quick start + prod deploy table.
- [`docs/SYSTEM_INDEX.md`](SYSTEM_INDEX.md) — system-wide source-of-truth map.
- [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md) — read-first agent context.
- [`BOUNDARY.md`](../BOUNDARY.md) — authority model + mutation boundaries.
- [`SECURITY.md`](../SECURITY.md) — secret handling.
- [`docs/specs/registry-yaml-schema.md`](specs/registry-yaml-schema.md) — the format of `control-plane/registry.yaml`.
- [`docs/runbooks/foundation-v2-cutover-2026-05-12.md`](runbooks/foundation-v2-cutover-2026-05-12.md) — the 2026-05-12 cutover lifecycle and the reusable pattern.
- ADRs in [`docs/adr/`](adr/) for early decisions (still mostly valid).
