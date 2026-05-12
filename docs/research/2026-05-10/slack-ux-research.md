# Research: Slack programmatic UX primitives for an internal AI agent cockpit

## Summary
For a high-leverage internal AI agent cockpit, the best MVP is a Bolt JS Socket Mode app combining a slash command and message shortcut as entry points, Block Kit progress cards updated via `chat.update`, buttons/actions for steering/cancel/approve, and modals for structured inputs. App Home is the best persistent cockpit/dashboard surface after the first workflow works; canvases are useful for durable runbooks or generated reports, but should be a later add-on because they are markdown/document APIs rather than interactive Block Kit surfaces.

## Ranked playbook: value vs implementation complexity

| Rank | Primitive | Value | Complexity | MVP recommendation |
|---:|---|---|---|---|
| 1 | `chat.postMessage` + `chat.update` progress cards | Very high | Low | Post one run card, persist `{channel, ts, run_id}`, update blocks as state changes. |
| 2 | Slash command | High | Low | `/agent ...` starts a run from anywhere; ack immediately, then post/update a visible or ephemeral status. |
| 3 | Block Kit buttons/actions | Very high | Medium | Add Approve, Reject, Cancel, Retry, Open Details buttons; ack every action fast. |
| 4 | Modals: `views.open` + `view_submission` | High | Medium | Use for structured task creation, parameter editing, approvals with comments. |
| 5 | Message shortcut | High | Medium | “Send to Agent” from a message context menu; ideal for summarization, triage, issue creation. |
| 6 | App Home | Medium-high | Medium | Add after MVP as personal control panel: active runs, queued approvals, settings. |
| 7 | Canvases | Medium | Medium-high | Use for durable generated plans/reports/runbooks; not as the live cockpit. |
| 8 | Response URLs / ephemeral responses | Medium | Medium | Useful for private confirmations, but avoid relying on them for long-running progress. |

## Findings

1. **Bolt JS Socket Mode is the right internal MVP transport.** Socket Mode lets the app receive Slack events over WebSocket without exposing a public HTTP endpoint; Bolt JS initializes it with `socketMode: true`, bot token, and app-level token. This is ideal for internal prototypes and local smoke tests. [Socket Mode docs](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/)

2. **Always acknowledge interactivity immediately; design all handlers around the 3-second rule.** Slack/Bolt requires `ack()` for actions, commands, shortcuts, options, and view submissions; Slack recommends calling it before DB calls or message sends because the response window is 3 seconds. For the cockpit, `ack()` first, enqueue work, then update Slack asynchronously. [Bolt ack docs](https://docs.slack.dev/tools/bolt-js/concepts/acknowledge)

3. **Slash commands are the lowest-friction “start an agent run” entry point.** Bolt listens with `app.command('/agent', ...)`; commands must be acknowledged, then can respond with `respond()` or post via Web API. Slack-created slash commands cannot be invoked from message threads, so thread-specific workflows should use message shortcuts or buttons instead. [Bolt command docs](https://docs.slack.dev/tools/bolt-js/concepts/commands), [Slash command docs](https://docs.slack.dev/interactivity/implementing-slash-commands)

4. **Message shortcuts are the best context-preserving entry point.** Message shortcuts provide the source message, channel, user, and a `trigger_id` usable for opening a modal; global shortcuts lack channel context. For an AI cockpit, implement “Send to Agent” and open a modal to confirm intent/options. [Bolt shortcut docs](https://docs.slack.dev/tools/bolt-js/concepts/shortcuts), [Shortcut payload docs](https://api.slack.com/reference/interaction-payloads/actions)

5. **Block Kit buttons/actions are the primary control surface.** Buttons and other interactive elements live in messages, modals, and App Home; Bolt listens with `app.action(action_id, ...)`. `block_actions` payload timing depends on component type; buttons send payloads on click. Use stable `action_id`s and encode only opaque IDs in `value`/`private_metadata`, not sensitive state. [Block Kit docs](https://docs.slack.dev/block-kit/), [Block actions payload](https://api.slack.com/reference/interaction-payloads/block-actions), [Bolt actions docs](https://docs.slack.dev/tools/bolt-js/concepts/actions)

6. **Modals are high leverage for structured input, but trigger IDs are short-lived and lifecycle-sensitive.** Open a modal with `views.open` from a shortcut/action/command `trigger_id`; handle submissions with `app.view(callback_id, ...)`. Modal views have max 100 blocks, require `submit` when using input blocks, and can use `private_metadata`; preserve input state during `views.update` by keeping the same `block_id` and `action_id`. [Modal view reference](https://docs.slack.dev/reference/views/modal-views), [Bolt view submissions](https://docs.slack.dev/tools/bolt-js/concepts/view-submissions), [Updating/pushing views](https://docs.slack.dev/tools/bolt-js/concepts/updating-pushing-views)

7. **Use `views.update` hashes to avoid modal race conditions.** Slack’s Bolt examples pass `body.view.hash` to `views.update` so stale updates do not overwrite newer modal state. This matters for agent cockpit forms with dynamic fields or validation. [Updating/pushing views](https://docs.slack.dev/tools/bolt-js/concepts/updating-pushing-views)

8. **App Home is a strong second-phase dashboard.** Slack sends `app_home_opened`; apps publish Home tab views with `views.publish`. The Home tab can include Block Kit and buttons, making it good for “My active runs,” pending approvals, preferences, and recent agent outputs. [Publishing App Home views](https://docs.slack.dev/tools/bolt-js/concepts/publishing-views), [Interactive modals in Home tab](https://docs.slack.dev/interactivity/adding-interactive-modals-to-home-tab)

9. **`chat.update` is the canonical progress-card mechanism.** `chat.update` updates a message by `channel` + `ts`, supports blocks, and avoids showing the edited flag when blocks are used. Only messages posted by the authenticated user/bot can be updated; normal ephemeral messages cannot be updated this way. For progress, post once, then update blocks for queued/running/needs-input/done/failed. [chat.update docs](https://docs.slack.dev/reference/methods/chat.update), [Modifying messages](https://docs.slack.dev/messaging/modifying-messages)

10. **Canvases are document/report surfaces, not interactive cockpit surfaces.** Slack canvas APIs create/edit markdown documents; current docs state Block Kit is not supported in canvases. Use canvases for generated project briefs, incident retros, research reports, runbooks, or long-lived task plans. Required scope is `canvases:write`; create/edit APIs use `document_content` with markdown. [Canvases guide](https://docs.slack.dev/surfaces/canvases), [canvases.create](https://docs.slack.dev/reference/methods/canvases.create), [canvases.edit](https://docs.slack.dev/reference/methods/canvases.edit/), [canvases:write scope](https://docs.slack.dev/reference/scopes/canvases.write)

11. **Events and retries require idempotency even when using Bolt.** Events API deliveries require HTTP 2xx within 3 seconds; failed deliveries retry up to three times with `x-slack-retry-num` and `x-slack-retry-reason`. In Socket Mode, retries can appear as `retry_attempt` in the body. Store processed event/action keys and make run creation idempotent. [Events API retries](https://docs.slack.dev/apis/events-api/), [Bolt retry discussion](https://github.com/slackapi/bolt-python/issues/868)

12. **Request signing matters for HTTP mode; Socket Mode reduces but does not remove auth discipline.** If using HTTP Request URLs, verify `X-Slack-Signature` with the app signing secret. Bolt’s receivers generally handle this when configured correctly, but custom endpoints and test harnesses must preserve raw request bodies for verification. [Request verification docs](https://api.slack.com/authentication/verifying-requests-from-slack)

## Concrete MVP design for Bolt JS Socket Mode

### Required Slack app features/scopes
- Enable Socket Mode and Interactivity.
- Add slash command: `/agent`.
- Add message shortcut: `Send to Agent` with callback ID such as `agent_from_message`.
- Bot scopes likely needed: `chat:write`, `commands`, relevant conversation read scopes for target channels, `app_mentions:read` only if using mentions, and `canvases:write` only if implementing canvases.

### Minimal interaction flow
1. User runs `/agent summarize launch risks` or uses message shortcut.
2. Handler calls `ack()` immediately.
3. App creates idempotent `run_id` and posts a Block Kit progress card.
4. Store `{run_id, channel, ts, user, source_message_ts, status}`.
5. Worker updates same card via `chat.update` as it moves through states.
6. Buttons: `Cancel`, `Approve`, `Open details`, `Retry`.
7. `Open details` launches a modal with structured fields and `private_metadata: {run_id}`.
8. App Home later lists active runs and pending approvals via `views.publish`.

### Progress-card states
- `queued`: posted immediately after ack.
- `running`: include current phase, elapsed time, and Cancel button.
- `needs_input`: include Approve/Reject/Edit buttons.
- `done`: summary, links, optional “Create canvas report.”
- `failed`: error class, Retry button, correlation ID.

### Idempotency keys
- Slash command: hash of `team_id:user_id:command:trigger_id` plus short TTL, or create explicit UUID at receipt.
- Message shortcut: `team_id:channel_id:message_ts:callback_id:user_id`.
- Block actions: `body.trigger_id` or `actions[0].action_ts` plus `run_id/action_id/user_id`.
- Events: `event_id` when present; fallback to `event_ts` + team/channel/user/type.
- Always tolerate duplicate button clicks by checking run state before mutating.

### Safe smoke testing checklist
1. Create a dev Slack workspace or private test channel.
2. Start Bolt JS in Socket Mode locally; no public tunnel required.
3. Test `/agent ping`: ack immediately, post card, update card to done.
4. Test every button once, then double-click rapidly to validate idempotency.
5. Test modal open + submit + validation error path.
6. Test message shortcut from a real message.
7. Test App Home open after subscribing to `app_home_opened`.
8. Test retry behavior by temporarily delaying ack beyond 3 seconds in dev only; verify duplicate suppression.
9. Test least-privilege scopes by reinstalling app after scope changes.
10. Avoid raw private-channel/DM data export; log IDs and redacted summaries, not full message text, unless explicitly approved.

## Sources
- Kept: Bolt acknowledgement docs (https://docs.slack.dev/tools/bolt-js/concepts/acknowledge) — core 3-second ack rule.
- Kept: Bolt Socket Mode docs (https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/) — internal/local app transport.
- Kept: Bolt shortcuts docs (https://docs.slack.dev/tools/bolt-js/concepts/shortcuts) — global/message shortcut implementation.
- Kept: Bolt commands docs (https://docs.slack.dev/tools/bolt-js/concepts/commands) — slash command handling.
- Kept: Block Kit docs (https://docs.slack.dev/block-kit/) — surfaces, blocks, interactive elements.
- Kept: Block actions payload docs (https://api.slack.com/reference/interaction-payloads/block-actions) — button/action payload behavior.
- Kept: Modal view reference (https://docs.slack.dev/reference/views/modal-views) — modal constraints and fields.
- Kept: Bolt view lifecycle docs (https://docs.slack.dev/tools/bolt-js/concepts/view-submissions, https://docs.slack.dev/tools/bolt-js/concepts/updating-pushing-views) — submission/update patterns.
- Kept: App Home docs (https://docs.slack.dev/tools/bolt-js/concepts/publishing-views) — `views.publish` dashboard surface.
- Kept: `chat.update` docs (https://docs.slack.dev/reference/methods/chat.update) — progress-card updates.
- Kept: Events API docs (https://docs.slack.dev/apis/events-api/) — retry schedule and headers.
- Kept: Canvas docs (https://docs.slack.dev/surfaces/canvases) — canvas API positioning and markdown limitation.
- Dropped: older legacy interactive message field guide — useful historical context but not preferred for new Block Kit/Bolt apps.
- Dropped: StackOverflow and GitHub issue threads except one retry note — practical but secondary to official docs.

## Gaps
- Slack docs do not provide a single canonical idempotency recipe for all interactivity payloads; implement app-level dedupe using payload IDs/timestamps plus run state checks.
- Canvas API availability and behavior can vary by workspace plan and permissions; verify in the target workspace before committing to canvas features.
- Exact rate limits for rapid `chat.update` progress animations should be validated empirically; prefer coarse state transitions over token-by-token updates.
