> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Covent Pi Mom — Known-good bare-bones Slack integration

Date: 2026-05-03

## Current working state

Bare-bones Slack → local bridge → Pi integration is working for the Covent Slack app.

Validated path:

```text
@Covent Pi mention in #idea-specs
  → Slack app Event Subscription app_mention
  → Socket Mode listener in local pi-mom bridge
  → threaded Slack acknowledgement / thinking message
  → local Pi subprocess
```

## Known-good identifiers

- Slack workspace/team: Covent
- Bot user: `covent_pi`
- Bot user ID observed: `U0B0VJJDKFH`
- Test channel: `#idea-specs`
- Test channel ID: `C0B05VBGJKF`
- Local bridge path: `/home/jfloyd/.pi/agent/pi-mom/index.mjs`
- Local env file: `/home/jfloyd/sources/covent-pi-mom.env`
- Start wrapper: `/home/jfloyd/sources/run-covent-pi-mom.sh`
- Current live PID observed: `13778` (`node index.mjs`)
- Current live log: `/home/jfloyd/sources/logs/pi-mom-pi-20260502-230422.log`

Do not store Slack token values in docs, git, Whimsical, chat, or logs.

## Required local env shape

`/home/jfloyd/sources/covent-pi-mom.env` should define:

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
export SLACK_TEST_CHANNEL_NAME="idea-specs"
export SLACK_ALLOWED_CHANNEL_ID="C0B05VBGJKF"
export EXPECTED_SLACK_BOT_USER="covent_pi"
export PI_COMMAND="pi"
export PI_EXTRA_ARGS=""
```

`PI_EXTRA_ARGS=""` means the bridge uses Pi defaults:

- provider: `openai-codex`
- model: `gpt-5.5`
- thinking: `high`

## Startup success criteria

A correct startup prints:

```text
🔑 Bot auth: covent_pi (...) on Covent
🔌 App-level token can open Socket Mode.
⚡️ Covent pi-mom is running in Socket Mode
Mode: pi
Test channel target: #idea-specs
Allowed channel: C0B05VBGJKF
📊 Tracing enabled. Look for [pi-mom-trace]
```

If startup prints any bot other than `covent_pi`, stop immediately: the wrong token set is loaded.

## Current trace proof

Observed after Slack mention:

```text
[pi-mom-trace] event=slack.received channel=C0B05VBGJKF mode=app_mention
[pi-mom-trace] event=slack.thread_context
[pi-mom-trace] event=pi.prompt_built
```

This proves Slack events are reaching the local Socket Mode listener and the bridge is building a Pi prompt.

## Operating modes

`PI_MOM_MODE=echo`:

- Minimal Slack event proof.
- Replies with `✅ Covent Pi event received`.
- No Pi subprocess.

`PI_MOM_MODE=pi`:

- Posts `👀 Covent Pi is thinking…`.
- Fetches thread context.
- Runs `pi --no-session -p <prompt>`.
- Updates the Slack thread with Pi output.

## 2026-05-06 image route MVP

Implemented a local OpenAI GPT Image MVP for Covent Pi:

- Shared client: `/home/jfloyd/.pi/agent/lib/openai-image-client.mjs`
- Pi extension tools: `/home/jfloyd/.pi/agent/extensions/openai-image-tools.ts`
  - `gpt_image_generate`
  - `gpt_image_edit`
- Skill: `/home/jfloyd/.pi/agent/skills/gpt-image-studio/SKILL.md`
- Subagent definition: `/home/jfloyd/.pi/agent/agents/gpt-image-studio.md`
- Slack route in bridge: `@Covent Pi image:` / `@Covent Pi image edit:`

Slack image behavior:

- `image:` / `image generate:` = text-to-image.
- `image edit:` = explicitly uses PNG/JPEG/WebP files from the current Slack thread as references.
- Generated files are uploaded back to the same Slack thread via `filesUploadV2` and saved locally under `PI_MOM_IMAGE_OUTPUT_DIR` or `~/.pi/agent/generated-images/slack`.
- The Slack bridge does not enable arbitrary Pi tools for image route; it calls the shared image client directly.

Smoke-tested locally with `gpt-image-1` low-quality generation and edit/reference flow. Syntax checks passed for the shared client, bridge, and doctor script. Pi extension load was validated with explicit `pi --no-extensions -e ... --tools gpt_image_generate`.

Activation requirements:

- `OPENAI_API_KEY` present in `/home/jfloyd/sources/covent-pi-mom.env` or wrapper env.
- `PI_MOM_MODE=pi` for live Slack route handling.
- Current Covent env doctor check passes for `covent_pi` and `#idea-specs`.

## Next hardening steps

1. Keep echo mode as the smoke test before Pi mode.
2. Restart pi-mom in `PI_MOM_MODE=pi` when ready to test the Slack image route live.
3. Add per-request confirmation/cost guard before high quality, many variants, or broad thread-image edits.
4. Add model override support via Slack prefix or env.
5. Add a small healthcheck script that validates:
   - `auth.test` returns `covent_pi`
   - `apps.connections.open` returns `ok: true`
   - `#idea-specs` is visible
   - bridge process is alive
6. Rotate tokens after pasted-token testing and reload via the local secrets script.
