> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Implementation Plan

## Goal
Deliver an MVP Slack-first Covent Agent OS UX that uses Block Kit confirmations/status, bounded smoke-testable agent runs, and a simple agent profile factory path that can later become a CLI for creating Pi agent profiles.

## Tasks
1. **PR 1: Slack UX module extraction and route catalog cleanup**
   - File: `apps/pi-mom/index.mjs`
   - Changes: Move Slack UI block construction and route metadata out of the monolithic entrypoint without changing behavior; keep existing `agent:` route, help/status output, app mentions, DMs, and `/thread-spec` intact.
   - File: `apps/pi-mom/lib/slack-routes.mjs`
   - Changes: New module exporting the current `ROUTES` catalog, route labels, instructions, and parser-facing metadata for `summarize`, `linear`, `agenda`, `escalation`, `spec`, `digest`, `image`, and `agent`.
   - File: `apps/pi-mom/lib/slack-ux.mjs`
   - Changes: New module for reusable message helpers: help text sections, status fields, route labels, and common ephemeral notices.
   - File: `apps/pi-mom/test-agent-run-card.mjs`
   - Changes: Add lightweight assertions for route catalog shape and help/status text generation once modules are extracted.
   - Acceptance: `npm --prefix apps/pi-mom run check` passes; Slack behavior remains unchanged in echo mode for `help:`, `status:`, `agent:`, and existing routed prefixes.

2. **PR 2: Improve Agent Run Card MVP into a clearer Block Kit workflow**
   - File: `apps/pi-mom/lib/agent-run-card.mjs`
   - Changes: Make confirmation/update cards more programmatic and operator-friendly: explicit run phase, safety boundary, selected runner mode, source thread link, recent events, and clear button labels. Add an overflow or section-based hint for supported MVP runners instead of relying on long context copy.
   - File: `apps/pi-mom/index.mjs`
   - Changes: Preserve current `agent_run_start` and `agent_run_cancel` actions, but standardize ephemeral notices through the new Slack UX helper. Keep execution bounded to existing modes: `fake`, `repo-health`, `supervised-pi` placeholder.
   - File: `apps/pi-mom/test-agent-run-card.mjs`
   - Changes: Assert cards contain `agent_run_start`, `agent_run_cancel`, runner mode, source link support, no unsafe execution language, and clear not-yet-wired copy for `supervised-pi`.
   - Acceptance: Creating `@Covent Pi agent: repo health smoke test` posts a confirmation card; Cancel transitions pending run to canceled; Start transitions fake/repo-health run through running to succeeded/failed with update card.

3. **PR 3: Add Slack modal/button foundation without broad new workflow surface**
   - File: `apps/pi-mom/manifest.yaml`
   - Changes: Add only the minimal interactivity/shortcut/slash-command manifest changes needed for an MVP agent launcher if not already present; do not remove existing broad Slack scopes from the current app manifest.
   - File: `apps/pi-mom/index.mjs`
   - Changes: Add a message shortcut or slash command handler that opens an Agent Run modal prefilled from the current thread context. Modal fields should collect task prompt and runner mode constrained to allowed MVP values.
   - File: `apps/pi-mom/lib/slack-agent-modal.mjs`
   - Changes: New module that builds Block Kit modal views and validates modal submissions into the same run creation path used by `agent:`.
   - File: `apps/pi-mom/test-agent-run-card.mjs`
   - Changes: Add pure unit assertions for modal block/action IDs and validation failures for empty prompts or invalid runner mode.
   - Acceptance: Operator can launch an agent run from Slack UI without typing the exact `agent:` prefix; modal submission creates the same confirmation card and still requires Start before execution.

4. **PR 4: Introduce agent profile factory core as reusable library**
   - File: `scripts/scaffold-agent.mjs`
   - Changes: Refactor reusable profile parsing, validation, and generated markdown rendering into a library while keeping the existing command behavior unchanged.
   - File: `lib/agent-profile-factory.mjs`
   - Changes: New library exposing functions for loading YAML-lite profiles, validating required profile keys, deriving tools/skills/thinking, and rendering agent, skill, and prompt markdown content.
   - File: `scripts/test-agent-profile-factory.mjs`
   - Changes: New bounded test script using temporary directories and fixture-like inputs to prove generation is deterministic, validates profile names, refuses invalid names, and does not overwrite without `--force`.
   - File: `package.json`
   - Changes: Add the test script into `npm run check` or `validate:agents` path.
   - Acceptance: Existing `npm run agent:new -- <name> --profile <profile>` behavior remains compatible; `npm run check` covers the factory core.

5. **PR 5: Add MVP Slack-to-profile factory planning endpoint, default-off**
   - File: `apps/pi-mom/index.mjs`
   - Changes: Add a default-off route such as `profile:` guarded by `PI_MOM_PROFILE_ROUTE_ENABLED=false` by default. It should parse a requested agent name, description, profile template, and optional skills, then post a preview card only; no file writes from Slack in MVP.
   - File: `apps/pi-mom/lib/profile-preview-card.mjs`
   - Changes: New Block Kit preview card showing proposed agent name, source profile, generated files that would be created by future CLI, permission boundary, and next command to run locally (`npm run agent:new ...`).
   - File: `apps/pi-mom/test-agent-run-card.mjs` or new `apps/pi-mom/test-profile-preview-card.mjs`
   - Changes: Assert route is default-off, invalid names are rejected, generated preview lists `agents/`, `skills/`, and `prompts/` targets, and no filesystem writes occur.
   - Acceptance: With the flag off, Slack replies with a disabled message. With the flag on, `@Covent Pi profile: ...` posts a preview only and never writes repo files.

6. **PR 6: Document bounded smoke tests and operator runbook**
   - File: `apps/pi-mom/README.md`
   - Changes: Add a concise Slack UX smoke-test matrix for app mention, DM, `/thread-spec`, Agent Run Card Start/Cancel, modal launch, and profile preview. Include exact env vars and expected visible Slack outcomes.
   - File: `docs/SYSTEM_INDEX.md` or `docs/AGENT_CONTEXT.md`
   - Changes: Link to the Slack UX/agent profile factory MVP path so future human+AI agents know where to start.
   - File: `LOCAL_DX.md`
   - Changes: Add local validation commands and advice to avoid duplicate Socket Mode workers against the same Slack app.
   - Acceptance: A new operator can run checks locally, start the bridge in echo/fake mode, complete the smoke matrix in the test Slack channel, and know what is intentionally not production-ready.

7. **PR 7: Prepare future CLI shape without implementing broad automation**
   - File: `docs/specs/agent-profile-factory-cli.md`
   - Changes: New short spec for the future CLI that creates Pi agent profiles from templates, including command shape, inputs, generated files, safety defaults, approval rules, and extension points for human+AI agents.
   - File: `agent-kits/profiles/README.md`
   - Changes: Document the MVP profiles as templates and clarify which profiles are safe for Slack preview versus local creation.
   - Acceptance: The future CLI behavior is unambiguous, but no Slack-triggered file writing, publishing, or remote mutation is introduced.

## Files to Modify
- `apps/pi-mom/index.mjs` - slim down route/UI code, add modal/profile-preview handlers, preserve existing pi-mom routes and action IDs.
- `apps/pi-mom/lib/agent-run-card.mjs` - improve Agent Run Card Block Kit content and update cards.
- `apps/pi-mom/test-agent-run-card.mjs` - expand bounded assertions for cards, route catalog, modal blocks, and profile preview behavior.
- `apps/pi-mom/manifest.yaml` - add minimal Slack interactivity entry points only if required by modal/shortcut UX.
- `apps/pi-mom/README.md` - document smoke tests and operator workflow.
- `scripts/scaffold-agent.mjs` - refactor to use shared factory library without changing CLI compatibility.
- `package.json` - wire new factory tests into checks.
- `agent-kits/profiles/README.md` - clarify profile template usage and Slack-safe boundaries.
- `docs/SYSTEM_INDEX.md` or `docs/AGENT_CONTEXT.md` - link MVP architecture/runbook.
- `LOCAL_DX.md` - document local validation and duplicate-worker cautions.

## New Files
- `apps/pi-mom/lib/slack-routes.mjs` - shared route catalog and route metadata.
- `apps/pi-mom/lib/slack-ux.mjs` - shared Slack message/status/notice helpers.
- `apps/pi-mom/lib/slack-agent-modal.mjs` - Block Kit modal builders and validators for agent launch.
- `apps/pi-mom/lib/profile-preview-card.mjs` - Block Kit preview for future profile creation.
- `lib/agent-profile-factory.mjs` - reusable profile loading, validation, and markdown rendering core.
- `scripts/test-agent-profile-factory.mjs` - deterministic smoke/unit tests for the factory core.
- `apps/pi-mom/test-profile-preview-card.mjs` - optional dedicated pure test for profile preview blocks.
- `docs/specs/agent-profile-factory-cli.md` - future CLI specification and non-goals.

## Dependencies
- PR 2 depends on PR 1 only if card helpers are moved into shared UX modules; otherwise it can proceed independently.
- PR 3 depends on PR 1 for route catalog/helpers and PR 2 for the finalized run creation/update path.
- PR 4 can proceed in parallel with Slack UX work because it is script/library-only.
- PR 5 depends on PR 1 for route organization and PR 4 for shared profile validation/rendering.
- PR 6 depends on PRs 1-5 so docs match shipped UX.
- PR 7 depends on PR 4 and should reflect any decisions made while extracting the factory core.

## Validation / Smoke Tests
- Static/local: `npm run check`, `npm --prefix apps/pi-mom run check`, `npm run validate:agents`, `npm run validate:skills`, and `npm run secret-scan`.
- Agent card unit: run `node apps/pi-mom/test-agent-run-card.mjs`; add modal/profile preview tests as pure Node scripts with no Slack or Pi invocation.
- Profile factory unit: run `node scripts/test-agent-profile-factory.mjs` with temporary directories only.
- Slack echo smoke: set `PI_MOM_MODE=echo`, `PI_MOM_AGENT_ROUTE_ENABLED=true`, `PI_MOM_AGENT_RUNNER=fake`, and a temp `PI_MOM_RUN_STATE_PATH`; verify `help:`, `status:`, app mention, and DM responses.
- Agent run smoke: in allowed Slack test channel, post `@Covent Pi agent: repo health smoke test`; click Cancel once; create another card and click Start; verify final status card and local run-state JSON contain no secrets.
- Modal smoke: launch the modal via the chosen shortcut/slash command, submit a valid prompt, verify confirmation card appears, then Start/Cancel works identically to `agent:`.
- Profile preview smoke: with `PI_MOM_PROFILE_ROUTE_ENABLED=false`, verify disabled response; with it enabled, verify preview card only and no files are created.

## Risks
- `/home/jfloyd/covent-agent-os/context.md` was not present when this roadmap was written, so any hidden context from that file needs explicit review before implementation.
- Slack manifest updates can overwrite existing broad app setup if applied carelessly; merge changes into the existing app rather than replacing scopes/events/commands.
- Socket Mode duplicate workers can double-handle Slack interactions; smoke tests should confirm Railway/local worker ownership before live testing.
- Slack modal/interactivity action IDs must remain stable and unique; changing existing `agent_run_start` or `agent_run_cancel` would break current cards.
- The repo currently keeps pi-mom mostly in `index.mjs`; extraction risks behavior drift unless tests are added before refactors.
- Broad Slack scopes exist, but MVP code must still enforce route flags, allowed-channel checks, no secret persistence, and no Slack-triggered repo writes.
- `supervised-pi` is intentionally represented but not wired; copying language from cards/docs must not imply real Pi execution until explicitly implemented.
- Canvas creation is best-effort and may fail due to Slack API support/scopes; it should not fail agent runs.

## What Not To Build Yet
- Do not build autonomous Slack-triggered repo writes, commits, pushes, deploys, or PR creation.
- Do not wire `supervised-pi` to execute real Pi commands from Slack in this MVP.
- Do not create a fully general workflow builder, scheduler, queue, database, or multi-agent orchestration system.
- Do not replace Linear/GitHub as durable systems of record with Slack messages or Canvas content.
- Do not add broad external mutations from Slack buttons beyond current bounded Start/Cancel and preview flows.
- Do not build the final profile-creation CLI in the Slack PRs; only extract the factory core and document the future CLI shape.
- Do not store Slack tokens, Pi prompts containing secrets, or generated credentials in run-state JSON or docs.
