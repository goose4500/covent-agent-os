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
bun install
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
bun --filter pi-mom run doctor
bun --filter pi-mom run start
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

Routed workflow prefixes (defined in `control-plane/registry.yaml`):

```text
@Covent Pi summarize: decisions, open questions, and next actions
@Covent Pi linear: create an issue from this thread (uses linear_create_issue tool, search-first)
@Covent Pi agenda: prep a meeting agenda from this thread
@Covent Pi spec: turn this idea into a safe implementation/spec draft (mirrors to a Slack canvas)
@Covent Pi bash: <command>   (runs via the bash tool; rm -rf/sudo/chmod 777/chown 777 require Slack approval)
```

Bare mentions (no prefix) get the full default Pi toolset (`bash`, `read`, `grep`, `find`, `edit`, `write`) so Pi can do work on its own machine; the permission-gate extension intercepts dangerous shell commands.

In `PI_MOM_MODE=echo`, the bridge acknowledges the detected route without invoking Pi. In `PI_MOM_MODE=pi`, the route injects a stronger workflow instruction into the Pi prompt.

Linear route behavior in `PI_MOM_MODE=pi`:

- Driven by the modular Linear Pi custom tools (`extensions/linear-tools.ts`): `linear_search_issues`, `linear_create_issue`, `linear_add_comment`.
- The model's prompt nudges it to search first, then comment-or-create — idempotency lives in the model's reasoning, not in a post-stream guard.
- Default target is Frontend Engineering / `Distribution` / `Backlog` (override with `LINEAR_TEAM_ID` / `LINEAR_PROJECT_ID` / `LINEAR_STATE_ID`).
- Requires `LINEAR_API_KEY`. Without it, each tool returns an `isError` result and the model reports the missing key to the user.

Streaming behavior in `PI_MOM_MODE=pi`:

- Streaming is always on via `lib/slack-sink.mjs` (Stage 5). It batches Pi `text_delta` events every ~200ms and emits zero-width-space heartbeats every 25s to keep Slack's stream session alive across long thinking runs.
- Pi tool gating is per-route via `control-plane/registry.yaml`. Routes with `tools: []` run with `noTools: "all"` and a `DefaultResourceLoader` configured with `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`; routes with a non-empty `tools:` allowlist call `setActiveToolsByName(...)` on the Pi session so only those tools are active. Token-like output is redacted before posting. Per-thread session resumption is handled by `lib/pi-session.mjs`.

## Observability & Tracing (DX)

Tracing is enabled by default. Every request logs structured JSON lines prefixed with `[pi-mom-trace]` containing:

- `slack.received` — incoming mention/DM
- `slack.thread_context` — how much context was pulled from the thread
- `pi.prompt_built` — prompt size sent to Pi, including detected route when present
- `pi.output_ready` — Pi run completion (SDK agent_end or timeout)
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
  → in-process Pi SDK session (createAgentSession)
```

Known-good non-secret values:

- Expected bot user: `covent_pi`
- Observed bot user ID: `U0B0VJJDKFH`
- Test channel: `#idea-specs`
- Test channel ID: `C0B05VBGJKF`
- Default mode for proof: `PI_MOM_MODE=echo`
- Full mode: `PI_MOM_MODE=pi`
- Pi model: `PI_MOM_MODEL=openai-codex/gpt-5.5` with `PI_MOM_THINKING_LEVEL=high` by default

Detailed historical runbook: `docs/runbooks/covent-pi-mom-known-good.md`

## Notes

- Streaming is always on via `lib/slack-sink.mjs`. The legacy `PI_MOM_STREAMING` knob was removed in Stage 5; there is no `chat.update` fallback path.
- Pi runs in-process with a session resolved per Slack thread (see `lib/pi-session.mjs`). Tool availability is per-route via `control-plane/registry.yaml`'s `routes:` block: routes with `tools: []` run with `noTools: "all"` and a `DefaultResourceLoader` that disables extensions/skills/prompts/themes/context-files — so private Slack snippets are not persisted in Pi session history and Slack context cannot trigger tool mutations. Routes that need explicit tool access declare each tool by name in registry.yaml; the SDK's `setActiveToolsByName(...)` narrows the active tool set after session creation.
- The `plain` route (bare `@Covent-Agent <prompt>` with no prefix) ships with the full default Pi toolset (`bash`, `read`, `grep`, `find`, `edit`, `write`) so Pi can do real work on its machine. The `permission-gate` extension intercepts `rm -rf` / `sudo` / `chmod 777` / `chown 777` via a Slack approval modal before they execute.
- The bridge uses Slack Web API only for the current thread context, final reply, canvas mirror (spec: route), and approval modals.
- If private-channel thread context fails, verify the app is invited to the channel and has `groups:history`.
