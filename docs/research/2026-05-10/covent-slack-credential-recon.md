# Covent Slack / Pi Mom credential reconnaissance

Date: 2026-05-10

## Likely correct credential source

1. **Preferred source of truth: 1Password item**
   - Vault/item: `op://Covent/Covent Pi Slack App/`
   - Fields found in docs/sessions:
     - `bot-token` -> `SLACK_BOT_TOKEN` (`xoxb-...`, value not printed)
     - `app-token` -> `SLACK_APP_TOKEN` (`xapp-...`, value not printed)
   - Evidence repeats in `apps/pi-mom/README.md` and many worktrees/sessions.

2. **Local secret-bearing env file also exists**
   - `/home/jfloyd/sources/covent-pi-mom.env`
   - File exists with mode `0600`; values were not printed.
   - Safe key/value evidence from that file:
     - `SLACK_BOT_TOKEN=[REDACTED]`
     - `SLACK_APP_TOKEN=[REDACTED]`
     - `SLACK_TEST_CHANNEL_NAME="idea-specs"`
     - `SLACK_ALLOWED_CHANNEL_ID="C0B05VBGJKF"`
     - `EXPECTED_SLACK_BOT_USER="covent_pi"`
     - `PI_COMMAND="pi"`
     - `PI_EXTRA_ARGS=""`

3. **Local wrapper**
   - `/home/jfloyd/sources/run-covent-pi-mom.sh`
   - Sources `/home/jfloyd/sources/covent-pi-mom.env`, then runs `npm run doctor` and `npm start` in `/home/jfloyd/.pi/agent/pi-mom`.

## Safe load/run commands

From `apps/pi-mom/README.md` preferred local load:

```bash
export SLACK_BOT_TOKEN="$(op read 'op://Covent/Covent Pi Slack App/bot-token')"
export SLACK_APP_TOKEN="$(op read 'op://Covent/Covent Pi Slack App/app-token')"
export EXPECTED_SLACK_BOT_USER="covent_pi"
export SLACK_TEST_CHANNEL_NAME="idea-specs"
export SLACK_ALLOWED_CHANNEL_ID="C0B05VBGJKF"   # optional restriction / smoke-test guard
```

Repo-based smoke/doctor:

```bash
cd /home/jfloyd/covent-agent-os
npm run doctor:pi-mom
npm run dev:pi-mom
```

Historical local bridge wrapper:

```bash
/home/jfloyd/sources/run-covent-pi-mom.sh
```

Production/Railway variable presence checks only; do not print values:

```bash
cd /home/jfloyd/covent-agent-os
railway status
railway variable list --json          # verify names/status only; do not paste values
railway deployment list --service covent-pi-mom --environment production
railway logs --service covent-pi-mom --environment production  # redact before sharing
```

## Expected bot/workspace/channel identity

- Workspace/team: `Covent` / `getcovent.slack.com`
- Bot user/name: `covent_pi` / `Covent Pi`
- Observed bot user ID: `U0B0VJJDKFH`
- Test channel: `#idea-specs`
- Test channel ID: `C0B05VBGJKF`
- Startup/doctor should confirm: `Slack bot auth: covent_pi (U0B0VJJDKFH) on Covent`.
- If auth reports any other bot/team, stop: wrong token set is loaded.

## Evidence locations

- `/home/jfloyd/covent-agent-os/apps/pi-mom/README.md:57-58` — preferred 1Password `op://Covent/Covent Pi Slack App/{bot-token,app-token}` commands.
- `/home/jfloyd/covent-agent-os/apps/pi-mom/README.md:216-231` — known-good bot/channel IDs and default channel posture.
- `/home/jfloyd/covent-agent-os/docs/runbooks/covent-pi-mom-known-good.md:18-43` — historical known-good identifiers, local env file, wrapper, required env shape.
- `/home/jfloyd/covent-agent-os/README.md:50-72` — Railway project/service/environment and required variable names.
- `/home/jfloyd/covent-agent-os/docs/SYSTEM_INDEX.md:135-149` — Railway production service and safe operational commands.
- `/home/jfloyd/covent-agent-os/apps/pi-mom/doctor.mjs:4-69` and `apps/pi-mom/index.mjs:15-31,917-934` — runtime checks for Slack tokens, expected bot, channel scope, Socket Mode.
- `/home/jfloyd/sources/run-covent-pi-mom.sh:4-24` — local wrapper sources `/home/jfloyd/sources/covent-pi-mom.env` and runs doctor/start.
- `/home/jfloyd/sources/covent-pi-mom.env.example:1-20` — placeholder env template with `C0B05VBGJKF`, `idea-specs`, `covent_pi`.
- `/home/jfloyd/.zsh_history:2752` — prior wrapper invocation: `/home/jfloyd/sources/run-covent-pi-mom.sh`.
- Prior Pi sessions with successful diagnostics:
  - `/home/jfloyd/.pi/agent/sessions/--home-jfloyd--/2026-05-06T17-01-11-141Z_019dfe3c-8064-7628-b062-a5fca472d8e2.jsonl:36,68,101,123,135,137,141,155` — doctor/start output showing `covent_pi (U0B0VJJDKFH) on Covent`, channel `#idea-specs`, allowed ID `C0B05VBGJKF`.
  - Same session `:66` shows a wrong-token case (`wholesalersai_interna` on another workspace), followed by corrected Covent token evidence at `:68`.
  - `/home/jfloyd/.pi/agent/sessions/--home-jfloyd--/2026-05-07T17-09-40-520Z_019e036a-a227-732d-80b7-af52cbde4a3f.jsonl:49,58,66,68` — successful doctor/preflight/startup evidence for `covent_pi`, Socket Mode, and `#idea-specs` visibility.

## Remaining unknowns / cautions

- I did not validate live 1Password access or read secret values.
- I did not contact Slack, Railway, or run the app.
- `SLACK_SIGNING_SECRET` was searched but is not required for current Socket Mode path; docs emphasize `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.
- Railway production variables should be verified by name/status only. Values must stay in Railway/1Password and should not be copied into logs, Slack, Linear, docs, or prompts.
