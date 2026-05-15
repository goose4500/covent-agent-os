> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Foundation Phase 3 — Slack Shortcut/Modal Cockpit Spec

Date: 2026-05-10  
Status: implementation-ready foundation spec; no code implemented  
Source note: `docs/specs/pi-mom-three-phase-agent-execution-plan.md` from PR #14 was not present in this worktree. This spec is based on the current `apps/pi-mom` implementation, `docs/specs/pr-closure-and-pi-mom-mvp-plan.md`, `slack-ux-research.md`, and existing Agent Run Card behavior.

## Goal

Add a thin Slack cockpit entry point that lets a user launch an existing bounded `agent:` run from a message shortcut and structured modal, without expanding runner authority.

Target loop:

```text
Slack message shortcut → modal with task/preset/context confirmation → pending Agent Run Card → Start/Cancel buttons → existing bounded runner → card update + optional artifact link
```

## User flow

1. User opens a Slack message context menu and selects **Send to Covent Agent**.
2. Shortcut handler `ack()`s immediately and opens a modal using the payload `trigger_id`.
3. Modal shows:
   - source message/channel/thread context summary by IDs/link, not full raw export;
   - required task text prefilled from selected message where safe or blank with placeholder;
   - bounded runner/preset selector, initially only existing allowed modes/presets (`fake`, `repo-health`, or whatever is currently enabled by `PI_MOM_AGENT_RUNNER` policy);
   - checkboxes/options for output target such as “reply in thread” and “create Canvas report” only if already supported/enabled;
   - safety copy: no deploy/push/merge/arbitrary shell from this surface.
4. On modal submit, handler validates synchronously enough to return field errors if needed; otherwise `ack()`s, creates a run through the same run-store/card path as `@Covent Pi agent: ...`, and posts a pending Agent Run Card into the source thread.
5. User clicks **Start Run** or **Cancel** on the existing card.
6. Existing `agent_run_start` / `agent_run_cancel` actions execute the bounded runner and update the same Slack message.
7. Duplicate shortcut submissions or retries resolve to the existing run/card instead of creating multiple runs for the same source/action/user within a short TTL.

## Slack manifest and app config requirements

Current manifest already has Socket Mode and interactivity enabled. Phase 3 needs a message shortcut added, then app reinstall.

Required manifest addition:

```yaml
features:
  shortcuts:
    - name: Send to Covent Agent
      type: message
      callback_id: agent_from_message
      description: Start a bounded Covent agent run from this message
```

Confirm/keep:

- `settings.interactivity.is_enabled: true`
- `settings.socket_mode_enabled: true`
- bot scope `commands` remains installed for slash commands/interactivity compatibility
- bot scope `chat:write` for posting/updating cards
- channel/DM history scopes are only used where current policy allows fetching source context

Operational requirement: update the existing Covent Pi app manifest, do not create a new Slack app. Reinstall after manifest changes. Avoid adding new broad scopes for this foundation slice.

## Likely files touched

Implementation should stay small and `.mjs`-based.

- `apps/pi-mom/manifest.yaml` — add message shortcut only.
- `apps/pi-mom/README.md` — document shortcut/modal flow, reinstall step, feature flags, and safe smoke test.
- `apps/pi-mom/index.mjs` — register `app.messageShortcut("agent_from_message", ...)` or `app.shortcut(...)`; register modal submission handler; call existing run/card helpers.
- `apps/pi-mom/lib/agent-run-card.mjs` — only if card copy needs source-link/modal-origin fields; keep builders pure.
- `apps/pi-mom/lib/agent-run-store.mjs` — only if adding idempotency keys/source metadata to run records.
- New focused helper module if needed, e.g. `apps/pi-mom/lib/agent-cockpit-modal.mjs`, for pure modal builders/parsers.
- Tests: existing `apps/pi-mom/test-agent-run-card.mjs` or new `apps/pi-mom/test-agent-cockpit-modal.mjs`; update `apps/pi-mom/package.json` check script only if a new test file is added.

## Implementation boundaries

- Reuse the existing Agent Run Card and runner path; do not create a second execution path.
- Encode only opaque IDs in `private_metadata` / action `value`; do not store secrets or full private Slack text in modal metadata.
- `ack()` all shortcuts, actions, and views within Slack's 3-second window.
- Use stable IDs:
  - shortcut callback: `agent_from_message`
  - view callback: `agent_cockpit_submit`
  - modal blocks/actions: `task_input`, `preset_select`, `output_options`
- Recommended idempotency key: `team_id:channel_id:message_ts:user_id:agent_from_message` plus normalized preset/task hash or short TTL.
- Feature flag suggestion: `PI_MOM_AGENT_COCKPIT_ENABLED=false` by default until manifest is installed and tested.

## Tests

Offline tests should not require Slack, Linear, Pi, or real tokens.

Minimum tests:

- modal builder emits valid Block Kit shape with callback ID, required input, and safe `private_metadata`.
- modal parser extracts task/preset/output options and rejects blank task or invalid preset.
- source metadata builder stores channel/message/thread/user IDs and source permalink only; no raw secret-like text.
- shortcut submission creates the same run shape expected by Agent Run Card helpers.
- duplicate idempotency key returns/reuses existing run instead of creating a second run.
- disabled feature flag prevents shortcut/modal run creation.
- existing Agent Run Card tests still pass.

Validation commands:

```bash
npm --prefix apps/pi-mom run check
npm run check
npm run secret-scan   # if feasible in the environment
```

## Non-goals

- No code implementation in this foundation task.
- No App Home dashboard.
- No Canvas-first cockpit; Canvas remains optional report output only.
- No passive channel listeners or auto-analysis.
- No new write-capable runner presets.
- No arbitrary prompt-to-shell, deploy, push, merge, or real external mutation from the modal.
- No TypeScript migration or large pi-mom refactor.
- No Slack profile factory or general workflow-builder platform.
- No new Slack app creation or unnecessary scope expansion.

## Acceptance criteria

- A future implementation PR can add one message shortcut and one modal with clear IDs and tests.
- The modal creates pending runs through the existing Agent Run Card path.
- Existing `Start Run` / `Cancel` behavior remains the sole approval/execution control.
- Manifest requirements are documented and limited to the message shortcut plus reinstall.
- Handlers are designed to `ack()` fast and perform work asynchronously.
- Duplicate Slack retries/double submissions are idempotent.
- Feature flag can disable the cockpit surface without breaking existing mention, DM, `/thread-spec`, image, Linear, or `agent:` flows.
- Test plan covers modal shape/parsing, idempotency, flag-off behavior, and regression of current Agent Run Card helpers.
