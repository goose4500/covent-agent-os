# ADR 0008: Capabilities declare their Slack `/`-command surface

Date: 2026-05-15
Status: accepted
Related: PR #105 (merged), issue #103, issue #99 (PR #102 in flight), issue #97 (PR #100 merged)

## Context

`apps/pi-mom/manifest.yaml` is the Slack app definition for Polaris (the Covent Pi Slack assistant). Before PR #105, its `slash_commands:` block was a hand-edited static list. As of `main` immediately prior to merge, it contained exactly one entry — `/thread-spec` — handled by a single `app.command("/thread-spec", ...)` registration in `apps/pi-mom/index.mjs`.

The repo now ships:

- 38+ skills under `skills/<name>/SKILL.md`
- 6 extensions under `extensions/*.ts`
- A growing MCP surface seeded by `PI_MCP_JSON_B64` into `${PI_AGENT_DIR}/mcp.json` on cold boot (see ADR 0006)

Adding a new `/`-bearing capability previously required edits in three locations that had no enforced relationship:

1. The capability source file (skill / extension / MCP server entry)
2. `apps/pi-mom/manifest.yaml` (`slash_commands:` block)
3. `apps/pi-mom/index.mjs` (`app.command(...)` registration)

…followed by a manual app reinstall in Slack to publish the manifest.

This is the canonical N×M drift problem: every new declaration has three places to update, and there is no mechanism that fails when one is forgotten. The cost of drift is silent — a declared command without a handler returns "did_not_understand"-shaped Slack errors; a handler without a declaration is dead code; a manifest entry without either is a phantom command in the Slack UI. None of these surface in CI or boot logs.

The Polaris assistant-surface ADR (0007) commits to "spec drafts, Linear-ready issues, meeting agendas, summaries, images, and bounded agent runs" — i.e., the `/`-surface is expected to expand, not contract. Continuing to hand-edit the manifest as that surface grows is incompatible with the work backlog already in flight: issue #97 (Slack MCP), issue #99 (shortcuts), issue #103 (this ADR's prompt), and the 7 other Slack-UX issues opened the same day.

## Decision

**Capabilities declare their own `/`-command metadata, next to the code that handles them. A sync script regenerates the manifest. CI gates drift. A separate workflow pushes the manifest to Slack on merge to `main`.**

### Declaration sites

- **Skills** — `slash_commands:` block in the YAML frontmatter of `skills/<name>/SKILL.md`.
- **Extensions** — sibling `extensions/<name>.slash-commands.json` (extensions are TypeScript and have no frontmatter).
- **MCP servers** — `slashCommands` array on the per-server entry in `.mcp.json`.

Each entry shape is the Slack manifest schema for slash commands: `command`, `description`, optional `usage_hint`, optional `should_escape` (defaults to `false`).

### Sync surface

Three modules under `apps/pi-mom/lib/` and one CLI in `scripts/` make this work:

| File | Role |
|---|---|
| `apps/pi-mom/lib/slash-command-discovery.mjs` | Walks `skills/`, `extensions/`, `.mcp.json`. Returns a deterministic, sorted list. Errors on duplicate command names across sources. |
| `apps/pi-mom/lib/slack-manifest-sync.mjs` | Line-scoped replace of the `slash_commands:` block in `apps/pi-mom/manifest.yaml`. Nothing else in the manifest is touched. |
| `scripts/sync-slack-manifest.mjs` | CLI with three modes: `--write` (default — regenerate + write if changed), `--check` (regenerate to memory, exit 1 on drift), `--push` (regenerate + write + POST to `apps.manifest.update`). |
| `apps/pi-mom/test-slash-command-handlers.mjs` | Asserts every declared command has a matching `app.command("/xxx", ...)` registration in `index.mjs`. |

### Enforcement

- `.github/workflows/ci.yml` runs `bun scripts/sync-slack-manifest.mjs --check` on every PR. A drifted manifest fails CI.
- `.github/workflows/slack-manifest-push.yml` runs `--push` when the manifest or any declaration source changes on `main`. The push uses an App Configuration Token (`xoxe-…`) sourced from `SLACK_APP_CONFIG_TOKEN` repo secret — never committed, never echoed.
- `test-slash-command-handlers.mjs` runs in `bun run check` and blocks PRs that declare a command without registering a handler.

## Implementation choices worth recording

**Custom 60-line YAML parser instead of pulling in `js-yaml`.** The frontmatter shape we accept is intentionally narrow (top-level scalars, a single list-of-objects under `slash_commands:`). A general YAML parser would let arbitrary structure into the manifest pipeline. The narrow parser raises on anything it does not recognize, which is the desired behavior — frontmatter complexity should not silently propagate into Slack.

**Line-scoped manifest replace instead of full YAML round-trip.** The Slack manifest is hand-curated outside the `slash_commands:` block (display name, OAuth scopes, assistant view config, app home settings). A YAML library round-trip would reformat the whole file and lose comments, anchor ordering, and Slack-specific conventions. The replace targets exactly the `slash_commands:` block and the indented entries that follow it, leaving everything else byte-identical.

**`--check` exits non-zero on drift; `--write` is the local fix.** This mirrors `gofmt -d` / `prettier --check`: the CI mode never modifies files, the dev mode is one command to bring the tree back into sync. The `--push` mode is intentionally separate from both — pushing to Slack is an external side effect and should never be a side effect of running tests or formatters.

**Name collisions across sources are fatal, not auto-prefixed.** A skill and an MCP server both declaring `/search` is a design error, not a configuration value. The discoverer raises with both source paths so the human can decide which wins; auto-prefixing (`/skill-search` vs `/mcp-search`) would obscure the conflict and pollute the Slack command list.

**Idempotent.** Running `--write` against a clean tree is a no-op. This is necessary for the sync to be safe to run from any machine, any branch, any CI step.

**Handler enforcement is a separate test.** `test-slash-command-handlers.mjs` is decoupled from the manifest sync — it asserts a structural property of `index.mjs` (every declared command has a handler) without depending on the YAML mutation logic. Either test can be debugged in isolation.

## Alternatives considered and rejected

**Keep the manifest hand-edited; rely on PR review to catch drift.** Rejected. PR review is the wrong tool for structural invariants — reviewers reliably miss missing entries, especially across files. With a 38-skill surface, manual review is a CI replacement that does not scale and degrades under load.

**Single central registry file (`slash-commands.yaml` at repo root).** Rejected. Splitting the source-of-truth between the capability and a registry recreates the drift problem at smaller scale: now every new skill needs entries in two files instead of three. The discoverer-from-source pattern is one fewer file to forget.

**PR-time workflow that edits the manifest in the PR.** Rejected. Auto-edits in PRs require write access to the PR branch, conflict ergonomically with rebases, and obscure who authored what. A `--check` gate is the same enforcement with none of these costs.

**Use Slack's `apps.manifest.export` as the source of truth and reverse-sync into the repo.** Rejected. The Slack-side manifest is editable through the dashboard and would let manifest changes land outside Git. The repo must remain canonical for everything Polaris-shaped (per ADR 0003).

**Auto-surface every MCP tool as a `/` command.** Rejected for now. MCP tool counts grow into the dozens per server (the GitHub MCP alone exposes 25 tools; see ADR 0006). Auto-surface would make the Slack `/` menu unusable. Per-server opt-in via `slashCommands` array keeps the surface curated.

## Consequences

**Positive**

- New `/`-bearing capability lands in the Slack UI by editing exactly one file (the capability's source).
- Renames and removals propagate cleanly: drop the entry, run sync, push merges. The push workflow handles deletion in Slack via `apps.manifest.update`.
- CI fails closed: a PR that adds a skill with a `/` command but forgets to wire a handler cannot merge.
- The pattern is reusable for any future capability surface that needs a registry — e.g., a Polaris CLI command list (issue #95), a Pi extensions toolbar, an autocomplete surface — by writing a second discoverer that reuses the same declaration sites.

**Negative / accepted costs**

- The push workflow requires `SLACK_APP_CONFIG_TOKEN` and `SLACK_APP_ID` as GitHub Actions repo secrets. The configuration token rotates roughly every 12 hours, so the workflow either accepts intermittent failures (and relies on the next merge to retry) or needs a token-rotation Action. We accepted the former for v1.
- A drifted production Slack app (manifest edited via dashboard) will be silently overwritten on the next merge to `main`. This is intentional — the repo is canonical — but operators editing in the Slack dashboard need to know.
- The custom YAML parser rejects valid YAML constructs (anchors, multi-line scalars beyond simple folded form, nested maps). If a skill author writes legal YAML the parser does not handle, they get a hard error at sync time. This is the correct trade-off for a constrained schema, but it surprises people who know YAML well.

## Validation evidence

- PR #105 merged at commit `e6d602a` on 2026-05-15 with all CI checks green ("Check (lint, validators, typecheck, secrets)" SUCCESS).
- The merged tree contains a regenerated `apps/pi-mom/manifest.yaml` with the `slash_commands:` block populated from the single `/thread-spec` declaration on the `slack-spec-draft` skill — verifying the discoverer + sync work end-to-end.
- `apps/pi-mom/test-slash-command-discovery.mjs` (223 LOC, all cases passing) covers: parsing each declaration site, sort determinism, name-collision detection, malformed frontmatter rejection, missing-file handling.
- `apps/pi-mom/test-slack-manifest-sync.mjs` (100 LOC) covers: idempotency, byte-identical preservation of unrelated manifest sections, behavior on a manifest that has no existing `slash_commands:` block.
- `apps/pi-mom/test-slash-command-handlers.mjs` (38 LOC) blocks the merge of any declared command without an `app.command(...)` registration.
- Runbook published at `docs/runbooks/slack-slash-command-sync.md`.

## Follow-ups

1. **Set production secrets.** `SLACK_APP_CONFIG_TOKEN` and `SLACK_APP_ID` are referenced in `.env.example` and `apps/pi-mom/.env.example` but not yet set as GitHub Actions repo secrets. Until they are, `slack-manifest-push.yml` will fail on merge and the manifest must be pushed manually via `bun scripts/sync-slack-manifest.mjs --push` from a machine that has the token. **This is a one-time operator step in the GitHub repo settings.**
2. **Decide on the multi-environment Slack app strategy.** Today there is one production Slack app. If staging/dev Slack apps are introduced, the push workflow needs an environment matrix and per-env config tokens. Defer until there is concrete demand.
3. **Resolve the ADR 0007 numbering collision.** Two ADRs landed at `docs/adr/0007-*.md` on 2026-05-15: `0007-ec2-workspace-root-for-production-pi-mom.md` and `0007-polaris-slack-assistant-surface.md`. Renumber one to 0008 (and bump this ADR to 0009) or accept the collision as a known artifact of parallel branches landing the same hour. Cosmetic but worth a 5-minute cleanup.
4. **Apply the same pattern to extensions and MCP at the source.** PR #105 ships the discoverer with three input shapes, but only the skill shape is exercised today (the `/thread-spec` declaration). When PR #102 (Slack thread-spec shortcuts) and the next MCP-backed `/` command land, exercise both extension and `.mcp.json` paths to confirm the discoverer behaves as documented under real load.
5. **Pre-existing test failure on `main` to track separately.** `apps/pi-mom/test-skill-discovery.mjs:65` fails (`covent-project-context-primer` resolves as `user` not `project-package`) on `origin/main`, unrelated to PR #105 or PR #106 (the Linear cross-team PR that surfaced it). File a discrete issue; do not bundle into this ADR's follow-ups.

## Notes

This ADR formalizes a pattern that is broader than Slack: **the surface a system exposes should be declared by the capability that owns it, with a discoverer that walks the declarations and a sync step that materializes the surface.** The same pattern applies to:

- A Polaris CLI command list (issue #95) — capabilities declare their CLI surface; a discoverer regenerates the help text and command table.
- The Claude Code skill index — already implemented elsewhere in Jake's tooling via `~/.local/bin/sync-skills-to-notion`.
- An autocomplete or palette surface in any future Polaris UI.

The discoverer / sync / `--check` triad is the reusable shape. The Slack manifest is the first instance.
