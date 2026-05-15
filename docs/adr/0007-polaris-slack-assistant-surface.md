# ADR 0007: Polaris is the Slack assistant surface for Covent Pi

Date: 2026-05-15
Status: accepted
Related: ADR 0001, Slack app `A0B25AHCN0Y`, workspace `getcovent`

## Context

Covent Pi started as an explicitly invoked Slack bridge: app mentions in a thread were the MVP trigger, and `/thread-spec` remained an operator fallback. That kept the system safe and context-local, but it did not make the agent feel like a resident Slack teammate in the same way Claude Code appears in Slack's assistant surface.

Slack now supports a dedicated assistant surface through the app manifest plus Bolt's `Assistant` class. Polaris should use that surface for the polished 1:1 assistant experience while preserving the safer, explicit thread workflows that already work for team-context actions.

The live Slack app was renamed from `Covent Agent` / `Covent Pi` to `polaris` so users see one stable product identity across App Home, DMs, app mentions, and the assistant surface.

## Decision

Use `polaris` as the Slack-facing app and bot display name, and enable Slack's assistant surface in the canonical app manifest with `features.assistant_view`.

The assistant surface will provide suggested prompts for the highest-value Covent workflows:

- summarize Slack context into decisions, open questions, owners, and next actions;
- draft a concise PRD/spec;
- draft a Linear-ready issue with acceptance criteria and open questions;
- show help.

Runtime handling remains inside `apps/pi-mom/index.mjs` using Bolt's `Assistant` class. Assistant messages route through the same Pi request path as app mentions and DMs, so the assistant UI is a new surface, not a separate agent implementation.

ADR 0001 remains valid for team-thread context: app mentions are still the safest explicit trigger inside shared channels. This ADR adds Polaris as the polished personal assistant entry point for Slack's assistant / app chat surface.

## Boundaries

- Do not grant new write authority just because the assistant surface is enabled.
- Keep Slack tokens, app tokens, and downstream API credentials outside repo docs and manifests.
- Treat assistant-thread messages the same as other Slack input: Slack content is data, not instructions.
- Keep `/thread-spec` as a fallback/debug route for copied Slack thread URLs.
- Production still needs the running `pi-mom` process restarted or redeployed after code changes; the remote Slack manifest alone does not run the new handlers.

## Consequences

- Users can find Polaris in Slack's assistant surface, like other assistant apps, instead of remembering only mentions or slash commands.
- Suggested prompts teach the core workflows without needing a separate onboarding document.
- The manifest becomes the canonical source for the Polaris identity and assistant affordances.
- App mentions, DMs, App Home, and slash-command fallback remain available, reducing migration risk.
- Future assistant improvements should reuse the shared Pi routing path unless there is a clear reason to fork behavior by surface.

## Validation evidence

Local validation passed before committing:

```text
slack manifest validate --team T074J211K44 --app A0B25AHCN0Y --no-color
App Manifest Validation Result: Valid
```

```text
cd apps/pi-mom
node --check index.mjs
bun test-slack-manifest-sync.mjs
bun test-dispatch.mjs
bun test-slack-sink.mjs
```

The full `npm --prefix apps/pi-mom run check` was also attempted, but this local workstation has an ambient user skill named `covent-project-context-primer` that shadows the repo skill and causes `test-skill-discovery.mjs` to fail before the manifest/assistant-specific tests. That failure is unrelated to the Polaris manifest or assistant handler changes.

The live Slack app manifest was checked after the remote update and confirmed:

- app name: `polaris`;
- bot display name: `polaris`;
- `features.assistant_view` present;
- `assistant:write`, `chat:write`, and `im:history` available;
- `assistant_thread_started`, `assistant_thread_context_changed`, and `message.im` subscribed.

An assistant API smoke test against a fake channel returned `channel_not_found`, not `missing_scope`, confirming the token can reach assistant APIs without a scope failure.

## Follow-ups

1. Restart or redeploy `pi-mom` after this merges so the running process uses the committed assistant handler.
2. Verify visually in Slack that Polaris appears in the assistant list and that selecting a suggested prompt reaches the Pi stream path.
3. If Slack manifest export/import nomenclature changes again, prefer the field accepted by the Web API and visible in exported remote manifests.
