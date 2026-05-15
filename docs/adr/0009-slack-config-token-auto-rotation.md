# ADR 0009: Slack App Configuration Token auto-rotation in CI

Date: 2026-05-15
Status: accepted
Related: ADR 0008 (capabilities declare slash-command surface), PR #114 (manifest push format fix), PR #115 (auto-rotation workflow)

## Context

ADR 0008 established that `slack-manifest-push.yml` pushes `apps/pi-mom/manifest.yaml` to the Slack app via `apps.manifest.update` whenever declaration sources change on `main`. That workflow requires two secrets:

- `SLACK_APP_CONFIG_TOKEN` — an App Configuration Token (`xoxe.xoxp-…`), the only token type Slack accepts for `apps.manifest.update`
- `SLACK_APP_ID` — the target app ID (`A0B25AHCN0Y`)

Slack hard-codes a **12-hour TTL** on all App Configuration Tokens and provides no mechanism to extend it. A refresh token (`xoxe-1-…`) can mint a new access + refresh pair via `tooling.tokens.rotate`, but this exchange invalidates the previous refresh token, making the chain single-threaded.

Before this ADR, the workflow broke silently in three ways on first real-world use:

1. **`invalid_manifest`**: `pushToSlack()` sent raw YAML to `apps.manifest.update`, which requires `JSON.stringify` of the manifest object (PR #114 fix).
2. **`no_permission`**: The Slack workspace used to generate the token (Wholesalersai) does not own the Polaris app — the app lives in the **Covent** workspace. Configuration tokens are workspace-scoped; a token from the wrong workspace cannot update another workspace's app.
3. **`invalid_refresh_token`**: When the access token expired, the stored refresh token was already invalid (it had been rotated during debugging and the new pair was never captured into secrets). Every expiry required a human to open `api.slack.com/apps`, generate a fresh token, and paste it into the repo secret.

The Polaris app is expected to receive new slash commands, skills, and MCP tools frequently (see ADR 0008 follow-ups). Each of those changes triggers `slack-manifest-push.yml`. A 12-hour hand-rotation window makes the workflow unreliable for any merge that lands more than 12 hours after the last manual refresh.

### What `apps.manifest.update` actually expects

Slack's API requires:
- A token from the workspace that **owns** the app (Covent, not Wholesalersai)
- `manifest` parameter = `JSON.stringify(manifestObject)`, not a raw YAML string
- The manifest object must match the live app's schema exactly — unknown fields are rejected

The live Polaris app manifest contains fields not tracked in the repo (`functions`, `hermes_app_type`, `function_runtime`, user OAuth scopes, a `shortcuts` entry for `idea->agent->rnd-spec`). Pushing the repo's manifest verbatim would silently delete these.

## Decision

**The `slack-manifest-push` workflow rotates its own token at the start of every run and writes the new pair back to repo secrets before doing anything else.**

Concretely:

1. **Rotate first**: Call `tooling.tokens.rotate` with `SLACK_APP_CONFIG_REFRESH_TOKEN` at job start. This always produces a fresh `xoxe.xoxp-…` access token and a new `xoxe-1-…` refresh token.
2. **Mask immediately**: `::add-mask::` both values before they touch any other step, log line, or output file.
3. **Write back**: Update both `SLACK_APP_CONFIG_TOKEN` and `SLACK_APP_CONFIG_REFRESH_TOKEN` in repo secrets via `GH_PAT` (a classic PAT with `repo` scope, stored as a separate secret). This seeds the next run's rotation.
4. **Push with the fresh token**: Pass the access token to the manifest push step via `GITHUB_OUTPUT` — never via an env file that persists across steps.

### `pushToSlack()` strategy (PR #114, pre-requisite)

The manifest push function was also changed from "send repo YAML" to **export → patch → push**:

1. `apps.manifest.export` fetches the live manifest JSON from Slack.
2. Patch only `features.slash_commands` with the discovered commands.
3. `apps.manifest.update` with `JSON.stringify(patchedManifest)`.

This preserves all live-app settings the repo does not manage (user scopes, shortcuts, `functions`, `is_mcp_enabled`, `hermes_app_type`) and eliminates the YAML-vs-JSON format mismatch.

### Required secrets

| Secret | Value shape | Managed by |
|--------|-------------|------------|
| `SLACK_APP_CONFIG_REFRESH_TOKEN` | `xoxe-1-…` | Auto-rotated each run; seed manually once |
| `SLACK_APP_CONFIG_TOKEN` | `xoxe.xoxp-…` | Auto-rotated each run; useful for local `--push` |
| `SLACK_APP_ID` | `A0B25AHCN0Y` | Static — set once, never changes |
| `GH_PAT` | Classic PAT (`repo` scope) | Set once; rotate when PAT expires |

## Implementation choices worth recording

**`tooling.tokens.rotate` over manual generation.** The Slack UI generates tokens interactively (requires browser + Slack login + workspace selection). `tooling.tokens.rotate` is a machine-callable API that takes the current refresh token and returns a new pair in one HTTP call. Automating rotation via the UI is not possible.

**Rotation at job start, not on a schedule.** A separate scheduled workflow would need to run on a cadence shorter than 12 hours and handle the case where the push workflow also runs concurrently. Rotating at job start is simpler: the token is always fresh when needed, and concurrency is already gated by `concurrency: group: slack-manifest-push, cancel-in-progress: false`. Two concurrent runs cannot both rotate — the second one would see `invalid_refresh_token` from the now-consumed pair. The concurrency gate prevents this.

**`::add-mask::` before `GITHUB_OUTPUT`.** GitHub Actions redacts masked strings from subsequent log lines but not from env files or output files unless masking is set before the write. The rotation step masks both values before writing `slack_token` to `GITHUB_OUTPUT`, ensuring neither token appears in the push step's log even if the push script emits it in a debug message.

**`GITHUB_OUTPUT` not env export for inter-step token passing.** A token exported via `$GITHUB_ENV` persists for the rest of the job and appears in runner's environment dump on failure. `GITHUB_OUTPUT` is step-scoped and read only by steps that reference `${{ steps.rotate.outputs.slack_token }}` — narrower blast radius.

**`GH_PAT` not `GITHUB_TOKEN` for secret writes.** `GITHUB_TOKEN` is scoped to the workflow run and cannot read or write repository secrets — this is an explicit GitHub limitation. A classic PAT with `repo` scope can call `PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}` directly (which is what `gh secret set` does). The PAT is stored as a repo secret itself; its exposure risk is bounded by GitHub Actions' secret isolation.

**`GH_PAT` scope is `repo`, not `secrets:write`.** Fine-grained PATs support a dedicated `secrets:write` permission, which would be narrower. Classic PATs use `repo` as the applicable scope (includes secret management for private repos). A future hardening pass could replace the classic PAT with a GitHub App installation token with minimal permissions.

**`apps.manifest.export` + patch rather than full repo manifest push.** The Polaris app has accumulated live config that predates this repo's manifest (`functions` block, user OAuth scopes for Search API, `shortcuts`). Pushing the repo manifest verbatim would delete these. The export-patch-push strategy treats the repo as the source of truth for slash commands only, which is the scope ADR 0008 actually governs. Bringing the full manifest under repo control is deferred as a separate decision.

## Alternatives considered and rejected

**Separate scheduled workflow (`cron: '0 */6 * * *'`)** to pre-rotate the token every 6 hours. Rejected. Adds a second workflow with no push intent, requires a `workflow_dispatch` or a dummy commit to also trigger the push, and creates a race condition if a push workflow starts between the cron run and the secret write. Rotating at push-job start is simpler and correctly ordered.

**GitHub App installation token instead of classic PAT.** A GitHub App with only `secrets:write` + `metadata:read` on this repo would be more narrowly scoped than a classic PAT. Rejected for now — adds GitHub App registration, key management, and a `create-github-app-token` action step. The classic PAT is sufficient for a single-repo tool; revisit when the pattern spreads across repos.

**Store the token in a cloud secret manager (e.g., AWS Secrets Manager, 1Password Secrets Automation).** Would eliminate the self-referential "secret that writes secrets" pattern. Rejected — introduces an external dependency and egress for what is currently a single-repo concern. Revisit if this pattern is needed across multiple repos or organizations.

**Accept token expiry; alert on failure and rotate manually.** Rejected. The push workflow is fully automated and merges happen at any time. A merge at hour 11 of a 12-hour token window works; a merge at hour 13 fails silently until someone notices the manifest drifted. The failure mode is invisible (Slack still shows the old manifest, no error surfaces to the author). Automation is the only reliable answer.

**Rotate only on failure (retry with fresh token).** Rejected. Requires detecting the specific `not_authed` / `token_expired` error code and looping. More complex than rotating unconditionally; also leaves a window where a partially-expired token is used optimistically and the failure burns the retry budget.

## Consequences

**Positive**

- The workflow is perpetually self-healing. No operator action is needed after the initial secret seeding.
- `SLACK_APP_CONFIG_TOKEN` in repo secrets is always current — useful for local `bun scripts/sync-slack-manifest.mjs --push` runs after sourcing `~/.secrets`.
- The export-patch-push strategy means `pushToSlack()` is non-destructive to live app settings the repo does not govern. Future live config added via the Slack dashboard is preserved through pushes.
- Improved error detail: `pushToSlack()` now surfaces `response_metadata.messages` in addition to `data.errors`, making future Slack API errors easier to diagnose.

**Negative / accepted costs**

- `GH_PAT` is a long-lived credential. If it is revoked, expired, or its `repo` scope is removed, the rotation step fails and the token chain breaks. The failure is loud (rotation exits 1 before the push runs) but requires a human to issue a new PAT and re-set `GH_PAT`. Mitigation: add the PAT's expiry date as a calendar reminder.
- The refresh token chain is **single-threaded and non-recoverable without human action** if the chain breaks (e.g., two concurrent runs somehow both attempt rotation despite the concurrency gate, or the runner is killed between the rotation response and the `gh secret set` write). If this happens, a new refresh token must be generated manually from `api.slack.com/apps` and stored as `SLACK_APP_CONFIG_REFRESH_TOKEN`.
- The export-patch-push strategy means `manifest.yaml` in the repo does not fully describe the live Slack app. A reader of the repo cannot reconstruct the full app state from the codebase alone. This is an intentional trade-off against destructive manifest pushes.

## Validation evidence

- **PR #114** (merged `8dcfaf2`): `pushToSlack()` rewritten to export → patch slash_commands → push JSON. Tested locally: `bun scripts/sync-slack-manifest.mjs --push` returned `✓ Slack manifest updated (app_id=A0B25AHCN0Y)` against the live Polaris app in the Covent workspace.
- **PR #115** (merged `b62986a`): Auto-rotation step added to `slack-manifest-push.yml`. CI passed (`Check` job: SUCCESS).
- **Workflow run `25916137515`** (`workflow_dispatch` on `main`): Both jobs passed in 12s. `SLACK_APP_CONFIG_TOKEN` updated `11:32Z → 11:47Z`; `SLACK_APP_CONFIG_REFRESH_TOKEN` updated `11:46Z → 11:47Z` — confirming the rotation wrote fresh secrets back to the repo during the run.

## Follow-ups

1. **Replace `GH_PAT` with a GitHub App installation token** scoped to `secrets:write` on this repo only. Eliminates the broad `repo`-scope PAT. Low urgency while this is a single-repo tool.
2. **Bring the full Polaris manifest under repo control.** The repo currently governs only `slash_commands`. User OAuth scopes, shortcuts, `functions`, `is_mcp_enabled`, and `hermes_app_type` all live exclusively in the Slack dashboard. A future ADR should decide whether to capture these in `manifest.yaml` and when that push becomes the authoritative source.
3. **Add PAT expiry calendar reminder.** Classic PATs can be issued with a fixed expiry. Record the expiry date so the rotation chain does not break silently months from now.
4. **Resolve ADR 0007 numbering collision.** Two ADRs landed at `docs/adr/0007-*.md` on 2026-05-15 (`0007-ec2-workspace-root-for-production-pi-mom.md` and `0007-polaris-slack-assistant-surface.md`). One should be renumbered. Noted in ADR 0008 as well.
