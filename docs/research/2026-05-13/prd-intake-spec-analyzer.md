# PRD Intake — Slack zip → AI-proposed Linear issues → human approval

## Context

Andy posts spec handoffs into the `#polaris-prd-intake` Slack channel as `.zip` bundles (e.g. `prd-handoff-billing-cancellation-aut…zip` containing follow-up work items: internal refund-on-request automation, goodwill refund support, low-usage retention outreach, 3-month no-usage auto-cancel). Right now those zips just sit in Slack — someone has to read the specs and manually file Linear issues, which is the bottleneck this feature removes.

The pi-mom Slack bridge will auto-detect a zip in that channel, extract the spec text, have a Pi agent propose 1+ Linear issues (vertical-slice "tracer bullets") with AI-suggested team/project/priority, then post each proposal as a Slack card with **Approve / Cancel / Edit** buttons. Anyone in the channel can act on any card. Approve creates the Linear issue, Cancel marks it dismissed, Edit opens a pre-filled modal so a human can adjust title/description/priority/team/project before creation.

User-confirmed scope:
- Trigger: **any** `.zip` in the intake channel (no @mention needed)
- UX: **per-issue** Approve / Cancel / Edit buttons
- Permissions: anyone in the channel
- Linear routing: **AI proposes team + project per issue**, humans confirm via Edit

## Why this fits the existing system

The bridge already has every primitive we need except the file-upload entry point and per-issue card flow:
- `apps/pi-mom/index.mjs` — Bolt app, `handleRequest()` pipeline, `runPiWithSlackStream()` driver, App-Home cockpit, the `pendingApprovals` Map (with auto-republish hooks at lines 496–507).
- `extensions/linear-tools.ts` — `linear_search_issues`, `linear_create_issue`, `linear_add_comment` Pi tools we'll reuse for actual issue creation. Needs one small extension: optional `team_id` / `project_id` params on `linear_create_issue` so AI suggestions flow through (lines 277–339).
- `apps/pi-mom/lib/slack-ui-context.mjs` — `pendingApprovals` lookup pattern, `_resolvePendingFromButton` helper, modal `buildInputModalView` we'll mirror for the multi-field edit modal.
- `apps/pi-mom/control-plane/registry.yaml` — per-route tool gating & system prompts; we add a new `intake` route key.
- `apps/pi-mom/lib/action-resolver.mjs` — already resolves any new YAML route entry; no changes needed.
- `apps/pi-mom/lib/pi-sdk-runner.mjs` — already wires extension factories at line 157; we append the new `intakeTools` factory.
- `skills/to-issues/SKILL.md` — vertical-slice / tracer-bullet rules; we lift these into the intake system prompt.

## End-to-end sequence

1. Slack `file_shared` event → new `app.event("file_shared")` handler in `index.mjs`. Filters: channel === `SLACK_INTAKE_CHANNEL_ID`, file ends in `.zip` (or `mimetype === application/zip`), file_id not in dedupe LRU.
2. `client.files.info` → `url_private_download` → `fetch` with `Authorization: Bearer ${SLACK_BOT_TOKEN}`.
3. `lib/intake-zip.mjs` extracts using `adm-zip`. Enforces caps: `maxEntries 200`, `maxEntryBytes 5_000_000`, `maxTotalBytes 25_000_000` (zip-bomb guards). Decodes `.md`/`.txt` as utf-8; `.pdf`/`.docx`/binaries returned with `text: null` and a `skipped` reason (v1 ships markdown/text only).
4. `lib/intake-orchestrator.mjs` builds the prompt (cap aggregate text ~120 KB) and calls `runTurn({ surface: "intake_file", threadTs: <zipMessageTs>, prompt, action: resolveAction({kind:"route", routeKey:"intake"}) })`.
5. Inside the Pi run, the model is required to call the new `intake_propose_issues(issues: [...])` Pi tool exactly once. The tool stores the array in a module-level `Map<requestId, proposals[]>` keyed by `process.env._PI_INTAKE_REQUEST_ID` (set by the orchestrator pre-call).
6. Orchestrator posts a parent summary (extracted file manifest + skipped list) and one per-proposal card; each card registers a `pendingApprovals` entry of `type: "intake_proposal"`.
7. **Approve** (`app.action("pi_intake_approve")`): reads entry, calls a thin internal `createLinearIssueFromProposal()` helper (extracted from `linear-tools.ts` so we don't need a full Pi run just to file), uses proposal's `team_id`/`project_id` with env fallback, edits card to "Approved — FE-XXX <URL>".
8. **Cancel** (`app.action("pi_intake_cancel")`): edits card to "Canceled by `<@user>`", deletes pending entry, no Linear call.
9. **Edit** (`app.action("pi_intake_edit_launch")`): opens modal pre-filled with title/description/priority/team/project. `app.view("pi_intake_edit_modal")` merges values, runs same create path, updates card.

## New files (under `apps/pi-mom/lib/` unless noted)

- **`intake-zip.mjs`** — uses `adm-zip` (synchronous, in-memory, no native deps; correct fit for ≤10 MB PRD bundles).
  - `async downloadSlackFile(client, fileId, { fetchImpl, botToken }) → Buffer`
  - `extractZipBuffer(buffer, caps) → { files: [{ name, relPath, text|null, mediaType, sizeBytes, truncated }], skipped, totalBytes }`
- **`intake-orchestrator.mjs`** — owns detect → download → extract → prompt → Pi run → harvest from capture map → post parent + cards. Exports `handleIntakeZip({ client, event, fileInfo })`.
- **`intake-card.mjs`** — pure Slack-blocks builder. Three buttons with `action_id` `pi_intake_approve` / `pi_intake_cancel` / `pi_intake_edit_launch`, `value=approvalId`. Also `buildIntakeSummaryBlocks({ files, skipped, proposalCount })`.
- **`intake-edit-modal.mjs`** — `buildEditModalView({ approvalId, proposal })` returns `callback_id: "pi_intake_edit_modal"`, `private_metadata: approvalId`, blocks for title / description (multiline) / priority (static_select 0–4) / team_id / project_id. Helper `parseEditModalSubmission(view)`.
- **`intake-proposal-store.mjs`** — light wrapper around the existing `pendingApprovals` Map. Entry shape: `{ type: "intake_proposal", approvalId, channel, threadTs, parentMessageTs, cardMessageTs, proposal, status, claimedBy, claimedAt }`. Auto-syncs App Home via existing set/delete hooks (`index.mjs:496-507`).
- **`extensions/intake-tools.ts`** (new top-level extension) — registers the `intake_propose_issues` Pi tool. TypeBox schema enforces per-issue fields: `title` (≤240 chars), `description` (markdown), `priority` (0–4 optional), `suggested_team_id` / `suggested_project_id` (optional), `confidence` (0–1 optional), `blocked_by` (string[] optional). Writes payload to the capture map.

## Files to modify

- `apps/pi-mom/index.mjs` — add `SLACK_INTAKE_CHANNEL_ID` env constant; extend `isAllowedChannel(channel, surface)` to accept the intake channel when `surface === "intake_file"`; new `app.event("file_shared")` with file-id LRU dedupe; new action handlers `pi_intake_approve` / `pi_intake_cancel` / `pi_intake_edit_launch`; new view handler `pi_intake_edit_modal`.
- `apps/pi-mom/manifest.yaml` — add `file_shared` under `settings.event_subscriptions.bot_events`. Existing scopes (`files:read`, `channels:history`, `chat:write`) are sufficient; no new scopes.
- `apps/pi-mom/control-plane/registry.yaml` — add:
  ```yaml
  intake:
    tools: ["intake_propose_issues"]
    systemPromptSuffix: "<see system-prompt sketch below>"
    approvals: none
  ```
  Plus a `legacyRoutes` entry for traceability.
- `extensions/linear-tools.ts` — extend `linear_create_issue` parameters (lines 277–295) with optional `team_id`, `project_id` (string UUIDs). When provided, override env defaults for that call only. Update `promptGuidelines`.
- `apps/pi-mom/lib/pi-sdk-runner.mjs` line 157 — append `intakeTools` to `extensionFactories: [permissionGate, linearTools]`.
- `apps/pi-mom/.env.example` — document `SLACK_INTAKE_CHANNEL_ID`, `INTAKE_DEFAULT_TEAM_ID`, `INTAKE_DEFAULT_PROJECT_ID`, `INTAKE_MAX_ZIP_BYTES`.
- `apps/pi-mom/package.json` — add `adm-zip` dependency (`bun add adm-zip`).

## System-prompt sketch for the `intake` route

1. **Role**: extracted PRD text from a zip dropped into `#polaris-prd-intake`. Job: propose 1+ Linear issues, each a discrete, independently grabbable work item.
2. **Input format**: user prompt contains a file manifest + each file's text content + a skipped/binary list.
3. **Rules** (lifted from `skills/to-issues/SKILL.md`): tracer-bullet vertical slices that cut through every layer, prefer AFK over HITL, mark blocked-by relationships, many thin slices over few thick.
4. **Per proposal fields**: title, markdown description (Problem / Context / What to build / Acceptance criteria / Blocked by), priority (0–4), `suggested_team_id`, `suggested_project_id`, confidence.
5. **Team/project guidance**: prompt includes the channel default team/project UUIDs (`INTAKE_DEFAULT_*`); keep defaults unless the spec text strongly implies a different team.
6. **Output**: call `intake_propose_issues` exactly once with the full array; no free-text proposals. After, write a one-line summary.

## Structured-output decision

Use a dedicated `intake_propose_issues` Pi tool, not a fenced JSON block in text. Same pattern `linear-tools.ts` uses; TypeBox validates the schema; the model cannot produce un-parseable JSON; the slack-sink already observes tool-call events. JSON-in-text is brittle (codex sometimes adds prose, wraps in extra fences, drops braces on long outputs).

## Channel allowlist strategy

Separate `SLACK_INTAKE_CHANNEL_ID` env var rather than CSV-expanding `SLACK_ALLOWED_CHANNEL_ID`. The two channels have different posture (mention-driven vs file-driven), different routes, different default Linear teams; keeping them separate prevents accidentally enabling `file_shared` ingestion in the other allowed channel.

## Concurrency & race conditions

- **Two zips in parallel**: each gets its own `requestId`, own thread, own capture-map slot, own `pendingApprovals` entries. Naturally isolated.
- **Click race** (User A clicks Edit, User B clicks Approve before A submits): claimed-by lock. First click sets `entry.claimedBy = userId` + `claimedAt = Date.now()`. Subsequent clicks within 60s post an ephemeral "claimed by <@A> 12s ago" and bail. Approve/Cancel clear the lock on completion; Edit clears on modal submit/close.
- **Bolt redelivery**: gate handlers on `entry.status !== "pending"` for idempotency.

## Risks to flag pre-implementation

- **PDF / DOCX coverage**: v1 markdown/text only; binaries listed as "skipped: not yet supported". `pdf-parse` / `mammoth` is a v2 follow-up.
- **Zip-bomb / size caps**: enforced in `intake-zip.mjs`; oversized uploads get a friendly thread error instead of OOM.
- **Secrets in spec files**: route extracted text through `redactSensitiveText` (`index.mjs:293-305`) before any `trace()` call. The Pi prompt receives raw text — expected — but logs only sizes/counts.
- **Pi run errors mid-batch**: orchestrator edits the parent summary to "Pi errored at proposal N — older cards remain actionable"; existing cards stay clickable.
- **In-memory state**: `pendingApprovals` is lost on restart. Same constraint already applies to permission-gate; acceptable for v1; persist later if needed.
- **Bot must be a channel member**: `file_shared` is only delivered to bots that are members. Document `/invite @Covent Pi` in `#polaris-prd-intake` in `README.md` and `.env.example`.

## Critical files

- `/home/user/covent-agent-os/apps/pi-mom/index.mjs`
- `/home/user/covent-agent-os/apps/pi-mom/manifest.yaml`
- `/home/user/covent-agent-os/apps/pi-mom/control-plane/registry.yaml`
- `/home/user/covent-agent-os/apps/pi-mom/lib/slack-ui-context.mjs`
- `/home/user/covent-agent-os/apps/pi-mom/lib/pi-sdk-runner.mjs`
- `/home/user/covent-agent-os/extensions/linear-tools.ts`
- `/home/user/covent-agent-os/skills/to-issues/SKILL.md` (reference only; prompt source)

## Verification plan

**Unit tests** (added as `apps/pi-mom/test-intake-*.mjs`, wired into `package.json`'s `check` script per existing pattern):
- `test-intake-zip.mjs` — fixture zips (md only, md + binary, oversized, zero entries, deeply nested); asserts caps and `skipped[]`.
- `test-intake-orchestrator.mjs` — DI fakes for `client`, `runTurn`, capture map; asserts prompt contains every file's text, posts one parent + N cards, registers N pending entries.
- `test-intake-card.mjs` — pure block builder; asserts `action_id`s + `value=approvalId`.
- `test-intake-edit-modal.mjs` — view round-trip; asserts `private_metadata` survives.
- `test-intake-tools.mjs` — registers the tool, executes with sample params, asserts capture map populated.
- `test-linear-tools.mjs` (modify existing) — add cases for the new optional `team_id`/`project_id` overriding env.

**Manual Slack smoke** (documented in `README.md`):
1. `bun start` with `SLACK_INTAKE_CHANNEL_ID` set to a private test channel; `/invite @Covent Pi`.
2. Upload a 3-file `.md` zip → expect parent summary + 1+ proposal cards in thread.
3. Click **Cancel** on one → card flips to "Canceled by <@you>"; no Linear issue created.
4. Click **Edit** on another → modal opens prefilled; change title; submit → card flips to "Approved (edited) — FE-XXX <URL>".
5. Click **Approve** on a third → card flips to "Approved — FE-YYY <URL>" with AI-suggested project.
6. Open App Home tab → pending count drops to zero.
7. Upload `.zip` in the other allowed channel → bot ignores it (trace logs `intake.ignored channel_not_allowed`).
8. Upload a 30 MB zip → bot posts "intake rejected: size cap" in thread.

**Success criterion**: step 5 produces a Linear issue in the AI-suggested project with the edited fields, no duplicates, and `pendingApprovals` empty afterward.
