> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Operational hygiene: secret rotation, hardcoded IDs, duplicate agent file

**Type**: `operational`
**Source**: 2026-05-12 24h audit (`docs/research/2026-05-12/audit-24h.md`); PR #24 known-follow-ups; validator warnings.
**Surface**: production secrets in Railway + 1Password (no code), `apps/pi-mom/index.mjs:50-52`, `agents/linear-auditor.md` vs `.pi/agents/linear-auditor.md`.
**Risk**: Variable per sub-task. Secret rotation is operational and time-sensitive; the code-side items are trivial.

## Context

Three operational follow-ups surfaced during the 24h audit. None block ongoing development, but all are real and one (secret rotation) was explicitly deferred during PR #24's merge and is still outstanding.

## Why

From the 24h audit:
- "Rotate exposed secrets … deferred per Jake's call" (PR #24 body, known-follow-ups section).
- "Linear team/project/state UUIDs in `index.mjs` (lines 50-52) — hardcoded as fallback constants. Not secrets, but personally identifying — fine inside a private repo, would be a leak if the repo ever opens."
- "`agents/linear-auditor.md` duplicates `.pi/agents/linear-auditor.md` (validator warning since before this window, but the merge added scrutiny to the agent surface)."

## Sub-tasks

### 1. Rotate four exposed production secrets
- [ ] **`SLACK_BOT_TOKEN`** (`xoxb-...`) — surfaced in earlier `railway variables --kv` dumps.
  - Generate new bot token in Slack app config for the `covent_pi` app.
  - Update `covent-pi-mom-v2` env in Railway.
  - Update `covent-pi-mom` (production) env in Railway (still tracking the new auto-deploy from `main`).
  - Update local `.env` files / 1Password vault entry.
  - **Do not commit** the new token anywhere.
- [ ] **`SLACK_APP_TOKEN`** (`xapp-...`) — Socket Mode token. Same rotation steps as above.
- [ ] **`OPENAI_API_KEY`** (`sk-proj-...`) — Note that pi-mom auth flows through `PI_AUTH_JSON_B64` (OAuth path), not `OPENAI_API_KEY`. Confirm whether `OPENAI_API_KEY` is actually still in use (`apps/pi-mom/index.mjs` does not reference it directly; `extensions/openai-image-tools.ts` was deleted in Stage 9). If unused, **delete from all envs** instead of rotating. If used by another extension or the SDK fallback, rotate.
- [ ] **`LINEAR_API_KEY`** (`lin_api_...`) — Generate new personal API key from Linear settings → API → Personal API keys. Update Railway envs (v2 + production). Update local `.env`.
- [ ] After rotation, verify each service in Railway shows `Healthy` and a fresh log line `🔑 Bot auth: covent_pi (...) on Covent` from the preflight at `apps/pi-mom/index.mjs:420-441`.
- [ ] Document the rotation in a runbook entry under `docs/runbooks/` (e.g. `secret-rotation-2026-05-XX.md`) capturing what was rotated, when, and who has access to the new values.

### 2. Move Linear team/project/state UUIDs out of `index.mjs` defaults
- [ ] In `apps/pi-mom/index.mjs:50-52`, the three lines are:
  ```js
  const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID || "c9c8376e-7fd3-4921-9996-8c98fc2274f2"; // FE
  const LINEAR_PROJECT_ID = process.env.LINEAR_PROJECT_ID || "ba9682e2-c14e-4208-98a2-a89f3fb285b8"; // Distribution
  const LINEAR_STATE_ID = process.env.LINEAR_STATE_ID || "adfdb6e9-b118-4d65-ada3-ad11087b7dab"; // Backlog
  ```
- [ ] Drop the literal-UUID fallbacks. Replace with:
  ```js
  const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID;
  const LINEAR_PROJECT_ID = process.env.LINEAR_PROJECT_ID;
  const LINEAR_STATE_ID = process.env.LINEAR_STATE_ID;
  ```
- [ ] Add the three IDs as required env vars in:
  - `apps/pi-mom/.env.example` (with placeholder values + comments pointing to where to find them in Linear).
  - `apps/pi-mom/.env.railway.example`.
- [ ] Add `LINEAR_TEAM_ID` to the `doctor.mjs` required-env list (`apps/pi-mom/doctor.mjs`) when `LINEAR_API_KEY` is set. Treat `LINEAR_PROJECT_ID` and `LINEAR_STATE_ID` as optional (Linear's API allows issue creation without them).
- [ ] Verify the live `covent-pi-mom-v2` and `covent-pi-mom` services already have these set explicitly in Railway (most likely yes; the constants were defensive defaults, not the canonical source).
- [ ] If the IDs are referenced by `extensions/linear-tools.ts` directly via `process.env.LINEAR_TEAM_ID` (they are — see `extensions/linear-tools.ts:209,297`), no change needed there.

### 3. De-duplicate `agents/linear-auditor.md` vs `.pi/agents/linear-auditor.md`
- [ ] Validator warning: `agents/linear-auditor.md: duplicate agent name linear-auditor; also defined in .pi/agents/linear-auditor.md` (from `bun run validate:agents`).
- [ ] Decide which copy is canonical. `.pi/agents/` is the Pi-runtime directory; `agents/` is the team-facing source per `package.json` `pi.agents: ["./.pi/agents", "./agents"]`.
- [ ] Diff the two files. If identical, delete one (prefer keeping `agents/linear-auditor.md` since it's the team-facing path).
- [ ] If they differ, reconcile to a single file and delete the other.
- [ ] Re-run `bun run validate:agents` and confirm the warning is gone. Other agent warnings (`missing defaultContext` on 8 files) are out of scope here; just clear the duplicate.

## Acceptance criteria

- [ ] All four secrets rotated, runbook entry committed, old secrets revoked / regenerated.
- [ ] `index.mjs:50-52` no longer contains literal UUIDs.
- [ ] `.env.example` + `.env.railway.example` document `LINEAR_TEAM_ID` / `LINEAR_PROJECT_ID` / `LINEAR_STATE_ID` as required/optional.
- [ ] `doctor.mjs` exits non-zero if `LINEAR_API_KEY` is set but `LINEAR_TEAM_ID` is missing.
- [ ] `bun run validate:agents` no longer reports the `linear-auditor` duplicate.
- [ ] `bun run check` green.
- [ ] Live canary on `covent-pi-mom-v2`: `linear: create an issue about X` still works (proves the env-driven IDs reach the tool).

## Out of scope

- Other validator warnings (8 agents missing `defaultContext`, 7 skills missing `description`). Address in a separate hygiene pass if desired.
- Migrating from personal Linear API key to an OAuth app — bigger lift, not required for this issue.
- Replacing `redactSensitiveText` in `index.mjs` — Bolt/web-api have no built-in outbound redactor (see Slack surface audit); hand-rolled is correct.

## References

- 24h audit: `docs/research/2026-05-12/audit-24h.md` (security review section + concrete follow-ups #1, #3, #5).
- PR #24 body: known follow-ups section ("Rotate exposed secrets…").
- `apps/pi-mom/index.mjs:50-52` — hardcoded Linear UUIDs.
- `package.json` `pi.agents` field — agent path resolution.
