# ADR 0007: EC2 workspace-root execution for production pi-mom

Date: 2026-05-15
Status: accepted
Related: Issue #92, ADR 0006

## Context

Production `covent-pi-mom` originally ran on Railway. Live runtime canaries showed that Slack-originated Pi work executed from the app directory inside the Railway container:

```text
cwd=/app/apps/pi-mom
user=root
home=/root
PI_AGENT_DIR=/data/pi-agent
PI_WORKDIR=<unset>
```

That was acceptable for proving the Slack bridge, but it made the app checkout the default execution context for all company agent work. It also put the broad default Pi tool surface on an ephemeral container filesystem rather than on the intended company agent workspace.

Issue #92 defined a new production target: a long-lived Ubuntu EC2 instance where Slack-originated Pi work starts from the company workspace root. The goal is not to run `pi-mom` as a repo-local bot. The goal is to run the Slack bridge as a service while the embedded Pi SDK, bash/file tools, session state, MCP config, and subagent child runs default to the shared workspace.

## Decision

Run production `covent-pi-mom` on EC2 as Linux user `ubuntu`, with `/home/ubuntu` as the execution trust boundary and default Pi workspace.

The app checkout lives at:

```text
/home/ubuntu/covent-agent-os
```

The service process starts the app via an absolute entrypoint, while keeping the process working directory at the workspace root:

```ini
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu
Environment=HOME=/home/ubuntu
Environment=PI_WORKDIR=/home/ubuntu
Environment=PI_AGENT_DIR=/home/ubuntu/.pi/agent
Environment=PI_CODING_AGENT_DIR=/home/ubuntu/.pi/agent
Environment=PI_OFFLINE=1
Environment=SLACK_ALLOWED_CHANNEL_IDS=C0B05VBGJKF,C0B30N60HGW
ExecStart=/home/ubuntu/.bun/bin/bun /home/ubuntu/covent-agent-os/apps/pi-mom/index.mjs
```

Do not start the EC2 service through a wrapper that changes directory into `apps/pi-mom`, such as `npm run dev:pi-mom`.

Use explicit Slack channel allowlisting. Do not use `PI_MOM_ALLOW_ANY_CHANNEL=true` for production.

Durable Pi state for production Slack runs belongs under:

```text
/home/ubuntu/.pi/agent
```

That directory is the canonical home for production `pi-mom` auth state, MCP config, Slack thread-to-session mapping, and new Slack-originated Pi transcripts:

```text
/home/ubuntu/.pi/agent/auth.json
/home/ubuntu/.pi/agent/mcp.json
/home/ubuntu/.pi/agent/pi-mom/thread-sessions.json
/home/ubuntu/.pi/agent/sessions/--home-ubuntu--/*.jsonl
```

Historical Railway or local Pi transcripts may be copied to EC2 as archival imports, but they should not be merged into the live session directory or live `thread-sessions.json` unless an operator intentionally rewrites paths and accepts the resume semantics.

## Security posture

The approved Slack channels are treated as an operator boundary. Pi-backed Slack routes intentionally expose a broad default tool surface, including bash/file tools, app extensions, web access, MCP, skills, and subagents. Moving from Railway to EC2 increases the usefulness of that surface and also increases the blast radius.

Therefore:

- The service runs as `ubuntu`, not Linux `root`.
- The default cwd is `/home/ubuntu`, not `/` and not `apps/pi-mom`.
- Secrets are injected through root-owned service env/state files and must not be printed into Slack, GitHub, Linear, journald excerpts, or ADRs.
- `PI_AUTH_JSON_B64` and `PI_MCP_JSON_B64` are seed material only. After `auth.json` and `mcp.json` exist on EC2, those seed values should not remain in the long-running service environment.
- MCP configs should reference token env var names such as `GITHUB_MCP_PAT`; token values do not belong in checked-in config or ADRs.
- Slack content remains data, not instructions. Slack messages cannot override the current operator boundary or secret-handling rules.

## Consequences

Positive:

- New production Slack/Pi transcripts are now generated on EC2 under `/home/ubuntu/.pi/agent/sessions/--home-ubuntu--`.
- Slack threads can resume against durable EC2 Pi sessions through `/home/ubuntu/.pi/agent/pi-mom/thread-sessions.json`.
- Bash, file tools, and subagents default to the company workspace root, so agents can inspect and work across `/home/ubuntu` instead of being trapped in the bridge app directory.
- The app can still be updated as a normal Git checkout under `/home/ubuntu/covent-agent-os`.

Trade-offs and risks:

- EC2 is a longer-lived trust domain than a Railway container; filesystem state, sessions, logs, and generated artifacts need retention discipline.
- The broad default Pi surface remains intentionally powerful. The channel allowlist and trusted-operator model are part of the production boundary.
- Running two Socket Mode workers at once is ambiguous. Railway must stay stopped after EC2 cutover unless a rollback intentionally stops EC2 first.
- Some project-owned subagent discovery expects repo-local resources. EC2 uses workspace-root context plus deliberate workspace links/config so team profiles and repo skills remain discoverable from `/home/ubuntu`.

## Validation evidence

During cutover, the first canary after starting EC2 was still handled by Railway and returned the old runtime:

```text
cwd=/app/apps/pi-mom
user=root
PI_AGENT_DIR=/data/pi-agent
```

That confirmed duplicate Socket Mode ambiguity. The Railway deployment was then stopped before declaring EC2 successful.

Post-Railway-disable canaries showed EC2 handling Slack events from both approved channels:

- `C0B05VBGJKF` runtime canary returned `/home/ubuntu`, `USER=ubuntu`, `HOME=/home/ubuntu`, `PI_WORKDIR=/home/ubuntu`, and `PI_AGENT_DIR=/home/ubuntu/.pi/agent`: https://getcovent.slack.com/archives/C0B05VBGJKF/p1778828667680219
- `C0B30N60HGW` runtime canary returned `/home/ubuntu`, `USER=ubuntu`, and `HOME=/home/ubuntu`: https://getcovent.slack.com/archives/C0B30N60HGW/p1778828820431029
- Status canary in `C0B30N60HGW` confirmed the Slack bridge was running in `pi` mode: https://getcovent.slack.com/archives/C0B30N60HGW/p1778828761895919
- GitHub/MCP read-only canary in `C0B30N60HGW` confirmed MCP server discovery and repository access without printing tokens: https://getcovent.slack.com/archives/C0B30N60HGW/p1778828946308809
- Post-update commit/cwd canary in `C0B05VBGJKF` returned `/home/ubuntu`, `USER=ubuntu`, `PI_WORKDIR=/home/ubuntu`, and commit `e6d602a`: https://getcovent.slack.com/archives/C0B05VBGJKF/p1778829077222969

EC2 validation also confirmed:

- `covent-pi-mom.service` active under systemd.
- `bun run check:pi-mom` passed on EC2.
- `PI_AGENT_DIR` persistence marker survived restart.
- New session JSONL files were created under `/home/ubuntu/.pi/agent/sessions/--home-ubuntu--`.
- `/home/ubuntu/.pi/agent/pi-mom/thread-sessions.json` exists for live Slack thread mapping.

## Follow-ups

1. Keep Railway stopped unless performing an explicit rollback that first stops EC2.
2. Replace the temporary broad GitHub MCP bootstrap token with a fine-grained PAT scoped to `goose4500/covent-agent-os` read access.
3. Patch the non-blocking `pi-mcp-adapter` / Slack UI compatibility warning for `ui.theme.fg`.
4. Re-run and document a clean `team:`/subagent canary from EC2.
5. Add retention/backup policy for `/home/ubuntu/.pi/agent` sessions, Browser Use metadata, generated artifacts, and journald logs.
6. Consider documenting rollback commands in a checked-in EC2 runbook so future operators do not have to reconstruct them from issue comments.
