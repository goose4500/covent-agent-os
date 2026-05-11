# Covent pi-mom Slack bridge

Local Socket Mode bridge for testing your first Pi AI agent in Covent Slack.

## 1. Paste the manifest

Open your Slack app settings → **App Manifest** → paste `manifest.yaml` → Save.

This enables:
- Socket Mode
- bot user `Covent Pi`
- `app_mention` events
- DM events via `message.im`
- slash command `/thread-spec`
- private-channel thread context for channels the app is invited into

When updating the deployed Covent app, update the existing app that owns bot user `covent_pi` / `U0B0VJJDKFH`; do not create a new Slack app. If editing an existing remote manifest, merge this command into the exported app config instead of overwriting pre-existing shortcuts, commands, scopes, functions, or event subscriptions.

## 2. Reinstall the app

After changing scopes/events/slash commands, go to **OAuth & Permissions** and reinstall the app to Covent. Slash commands require the `commands` bot scope to be installed/authorized.

Copy the **Bot User OAuth Token** (`xoxb-...`) into your local secret manager. Do not paste it into chat or git.

## 3. Create the app-level Socket Mode token

Go to **Basic Information → App-Level Tokens → Generate Token and Scopes**.

Create a token with:

```text
connections:write
```

Copy the app token (`xapp-...`) into your local secret manager.

## 4. Install local dependencies

From the repo root:

```bash
npm install
```

## 5. Load tokens locally

Example with a local untracked shell only:

```bash
export SLACK_BOT_TOKEN='xoxb-...'
export SLACK_APP_TOKEN='xapp-...'
```

Preferred with 1Password/op:

```bash
export SLACK_BOT_TOKEN="$(op read 'op://Covent/Covent Pi Slack App/bot-token')"
export SLACK_APP_TOKEN="$(op read 'op://Covent/Covent Pi Slack App/app-token')"
```

Required before `PI_MOM_MODE=pi` unless you intentionally override with `PI_MOM_ALLOW_ANY_CHANNEL=true`:

```bash
export SLACK_ALLOWED_CHANNEL_ID='C-or-G-channel-id-from-console'
```

Optional for creating Linear issues from Slack threads:

```bash
export LINEAR_API_KEY='lin_api_...'
# Defaults target Frontend Engineering / Distribution / Backlog.
# Override only if the Linear target changes:
# export LINEAR_TEAM_ID='c9c8376e-7fd3-4921-9996-8c98fc2274f2'
# export LINEAR_PROJECT_ID='ba9682e2-c14e-4208-98a2-a89f3fb285b8'
# export LINEAR_STATE_ID='adfdb6e9-b118-4d65-ada3-ad11087b7dab'
```

## 6. Run the bridge

From the repo root:

```bash
npm run doctor:pi-mom
npm run dev:pi-mom
```

Before live local testing, confirm whether the Railway production worker is already running. Do not intentionally run duplicate workers against the same Slack app/channel unless you are doing controlled debugging.

## 7. Test in private #idea-specs

In Slack private channel `idea-specs`:

```text
/invite @Covent Pi
@Covent Pi hello — prove the Slack → Pi → Slack loop works
```

The app will reply in the thread. For Pi mode, keep `SLACK_ALLOWED_CHANNEL_ID` set to the intended test channel so the bot fails closed outside that channel.

Built-in bridge commands:

```text
@Covent Pi help:
@Covent Pi status:
```

Preferred spec UX:

```text
# Reply inside the Slack thread you want turned into a spec
@Covent Pi draft spec
```

The app mention event includes the current thread context, so no one has to copy/paste a Slack URL. If this command is run outside a thread, the bot replies with a usage hint instead of guessing.

Fallback slash command:

```text
/thread-spec <Slack message/thread URL> [optional focus]
```

Use this only as an operator/debug fallback; the bridge replies ephemerally with usage/status and routes the spec draft into the referenced Slack thread.

Routed workflow prefixes:

```text
@Covent Pi summarize: decisions, open questions, and next actions
@Covent Pi linear: create an issue from this thread
@Covent Pi create Linear issue
@Covent Pi agenda: prep a meeting agenda from this thread
@Covent Pi escalation: brief this customer/problem escalation
@Covent Pi spec: turn this idea into a safe implementation/spec draft
@Covent Pi digest: create a compact digest from this context
@Covent Pi image: create a clean Covent hero visual for active buyer intelligence
@Covent Pi image: edit use the image attached in this thread as reference and restyle it as a polished Covent asset
```

In `PI_MOM_MODE=echo`, the bridge acknowledges the detected route without invoking Pi. In `PI_MOM_MODE=pi`, the route injects a stronger workflow instruction into the Pi prompt and constrains the SDK session to the route's `tools:` allowlist from `control-plane/registry.yaml`.

Pre-action approval (default-deny on dangerous tools) flows through `extensions/permission-gate.ts` → `apps/pi-mom/lib/slack-ui-context.mjs`, which renders Slack `alert` blocks with Yes/No buttons. The bridge resolves the pending approval when a button is clicked.

Per-thread session state lives at `PI_MOM_RUN_STATE_PATH` (default `~/.pi/agent/pi-mom/runs.json`): a JSON map of Slack threadTs → on-disk Pi session file. Do not store secrets there.

Linear route behavior in `PI_MOM_MODE=pi`:

- `linear:` / `create Linear issue` first asks Pi to write a Linear-ready issue spec from the Slack thread.
- Pi's first line should be `Title: <issue title>`; the bridge uses that as the Linear title.
- The full generated spec becomes the Linear issue description, plus a source Slack thread link and request ID.
- Default target is Frontend Engineering / `Distribution` / `Backlog`.
- Requires `LINEAR_API_KEY`. If missing, the bridge still posts the draft spec but replies that no Linear issue was created.

Streaming behavior in `PI_MOM_MODE=pi`:

- Pi runs embedded in-process via the `@earendil-works/pi-coding-agent` SDK. Each turn opens a Slack `chat.startStream` message; the SDK's `message_update` (`text_delta`) and `tool_execution_*` events are forwarded via `chat.appendStream`, then sealed with `chat.stopStream` on `agent_end`.
- Token-like output is redacted before posting to Slack. Per-Action tool gating is driven by `control-plane/registry.yaml`: each Action's `tools:` array constrains the SDK session via `session.setActiveToolsByName(...)`.

Image route behavior in `PI_MOM_MODE=pi`:

- `image:` is handled directly by the bridge, not by an unrestricted Pi subprocess.
- Requires `OPENAI_API_KEY` in the pi-mom environment.
- `image:` / `image: generate ...` calls text-to-image generation. `image: edit ...` explicitly uses Slack image files in the current thread as references.
- Generated files are uploaded back to the same Slack thread and saved locally under `PI_MOM_IMAGE_OUTPUT_DIR` or `~/.pi/agent/generated-images/slack`.
- Draft defaults are cheap/fast: `OPENAI_IMAGE_MODEL=gpt-image-1`, `OPENAI_IMAGE_QUALITY=low`, `OPENAI_IMAGE_SIZE=1024x1024`, `OPENAI_IMAGE_OUTPUT_FORMAT=png`.
- Optional knobs: `PI_MOM_IMAGE_ROUTE_ENABLED=false`, `PI_MOM_IMAGE_MAX_INPUTS=4`, `PI_MOM_IMAGE_MAX_BYTES=20971520`, `OPENAI_IMAGE_MODEL_FALLBACKS=gpt-image-1.5,gpt-image-1`.

## Observability & Tracing (DX)

Tracing is enabled by default. Every request logs structured JSON lines prefixed with `[pi-mom-trace]` containing:

- `slack.received` — incoming mention/DM
- `slack.thread_context` — how much context was pulled from the thread
- `pi.prompt_built` — prompt size sent to Pi, including detected route when present
- `pi.output_ready` — Pi stdout close/idle/timeout behavior
- `slack.stream_started` / `slack.stream_stopped` / `slack.replied_pi_stream` — streaming response lifecycle
- `slack.replied_echo` / `slack.replied_pi` / `slack.replied_help` / `slack.replied_status` — bridge response type
- `error` — any failures

Each event includes a `requestId`, `durationMs`, lengths, and other useful metadata.

To disable:
```bash
export PI_MOM_TRACE=false
```

You can pipe logs or `grep "pi-mom-trace"` for easy observability. This gives you clear end-to-end visibility for DX and debugging without external services.

## Known-good bare-bones state

As of 2026-05-03, the Covent Pi bridge has a working bare-bones path:

```text
@Covent Pi mention in #idea-specs
  → Socket Mode app_mention event
  → local bridge
  → Slack thread acknowledgement
  → Pi SDK session (embedded) in pi mode
```

Known-good non-secret values:

- Expected bot user: `covent_pi`
- Observed bot user ID: `U0B0VJJDKFH`
- Test channel: `#idea-specs`
- Test channel ID: `C0B05VBGJKF`
- Default mode for proof: `PI_MOM_MODE=echo`
- Full mode: `PI_MOM_MODE=pi`
- Pi model: whatever the SDK resolves from `~/.pi/agent/settings.json` or env-provided keys (OPENAI_API_KEY, ANTHROPIC_API_KEY); no `PI_EXTRA_ARGS`.

Detailed historical runbook: `docs/runbooks/covent-pi-mom-known-good.md`

## Notes

- Pi runs embedded as an SDK in-process (`@earendil-works/pi-coding-agent`). There is no `pi` subprocess and no `--no-tools` flag — per-Action tool restrictions come from `control-plane/registry.yaml` and are applied via `session.setActiveToolsByName(...)` on every turn.
- The bridge uses Slack Web API only for the current thread context and final reply.
- If private-channel thread context fails, verify the app is invited to the channel and has `groups:history`.
