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

```bash
cd /home/jfloyd/.pi/agent/pi-mom
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

## 6. Run the bridge

```bash
cd /home/jfloyd/.pi/agent/pi-mom
npm run doctor
npm start
```

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
@Covent Pi linear: draft an issue from this thread
@Covent Pi agenda: prep a meeting agenda from this thread
@Covent Pi escalation: brief this customer/problem escalation
@Covent Pi spec: turn this idea into a safe implementation/spec draft
@Covent Pi digest: create a compact digest from this context
@Covent Pi image: create a clean Covent hero visual for active buyer intelligence
@Covent Pi image edit: use the image attached in this thread as reference and restyle it as a polished Covent asset
```

In `PI_MOM_MODE=echo`, the bridge acknowledges the detected route without invoking Pi. In `PI_MOM_MODE=pi`, the route injects a stronger workflow instruction into the Pi prompt.

Streaming behavior in `PI_MOM_MODE=pi`:

- Default: `PI_MOM_STREAMING=true` streams Pi stdout into Slack with Slack `chat.*Stream` APIs.
- Buffering: `PI_MOM_STREAM_BUFFER_CHARS=1` starts/flushes quickly for live testing; raise it if rate limits become a problem.
- Safety: Slack-related environment variables are stripped from the Pi subprocess env, token-like output is redacted before posting, the prompt is passed via a temporary `0600` file instead of argv, and Pi tools/extensions are disabled unless `PI_MOM_ALLOW_PI_TOOLS=true`.
- Fallback: set `PI_MOM_STREAMING=false` to use the older `chat.postMessage` thinking message + final `chat.update` behavior.

Image route behavior in `PI_MOM_MODE=pi`:

- `image:` is handled directly by the bridge, not by an unrestricted Pi subprocess.
- Requires `OPENAI_API_KEY` in the pi-mom environment.
- `image:` / `image generate:` calls text-to-image generation. `image edit:` explicitly uses Slack image files in the current thread as references.
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
  → Pi subprocess in pi mode
```

Known-good non-secret values:

- Expected bot user: `covent_pi`
- Observed bot user ID: `U0B0VJJDKFH`
- Test channel: `#idea-specs`
- Test channel ID: `C0B05VBGJKF`
- Default mode for proof: `PI_MOM_MODE=echo`
- Full mode: `PI_MOM_MODE=pi`
- Pi model when `PI_EXTRA_ARGS=""`: Pi default `openai-codex/gpt-5.5` with high thinking

Detailed memory/runbook: `/home/jfloyd/.pi/agent/docs/covent-pi-mom-known-good.md`

## Notes

- In Pi mode, the bot streams Pi stdout into Slack by default; set `PI_MOM_STREAMING=false` for final-answer-only updates.
- Pi is launched with `--no-session --no-tools --no-extensions` by default so private Slack snippets are not persisted in Pi session history and Slack context cannot trigger tool mutations. Set `PI_MOM_ALLOW_PI_TOOLS=true` only for deliberate local experiments.
- The bridge uses Slack Web API only for the current thread context and final reply.
- If private-channel thread context fails, verify the app is invited to the channel and has `groups:history`.
