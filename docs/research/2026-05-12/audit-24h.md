# 24-hour codebase audit — covent-agent-os

- **Window**: 2026-05-11 18:00Z → 2026-05-12 18:00Z (≈24h)
- **Branch under review**: `main` (post-merge of `foundation-v2`) and in-flight `docs/post-foundation-2026-05-12`
- **Audit branch**: `claude/audit-codebase-24h-8oYNm`
- **Latest commit on main**: `1ab169c` — Merge PR #24 (`foundation-v2` → `main`) at 2026-05-12 16:01Z

## TL;DR

The 24h window was a single dominant push: a 27-commit, 10-stage rebuild of `apps/pi-mom` from a subprocess `pi` bridge to an in-process Pi SDK on bun, plus a Bolt 4.7 Assistant container, per-route tool gating, streaming via `chat.appendStream`, a canvas mirror for `spec:`, and ExtensionUIContext → Slack approval modals. Net ‑4,616 LOC across 76 files (PR #24, merged). One docs PR (#25) is open, three dependabot PRs are open. All local validators / 13 pi-mom test suites / `tsc --noEmit` are green after `bun install`. No new secrets in the tree; gitleaks + custom scan both pass.

The two real risks to flag are (1) the `plain` route now activates the full default Pi toolset on bare `@Covent-Agent` mentions — gated only by the channel allowlist and a 3-pattern permission-gate, and (2) the production rotation of `OPENAI_API_KEY` / `LINEAR_API_KEY` / `SLACK_*_TOKEN` was explicitly deferred in PR #24's body but still outstanding.

## Activity at a glance

| Surface | Count |
|---|---|
| Commits on `main` (24h) | 27 |
| Unique files touched | 76 |
| Net LOC | −4,616 (insertions 7,582 / deletions 12,198) |
| PRs merged | #24 (`foundation-v2`), #21 + #23 (dependabot yaml 2.8.4 → 2.9.0 in root + pi-mom) |
| PRs opened, still open | #25 (docs refresh), #22 (`@types/node` 22→25), #10 (`typescript` 5.9.3→6.0.3) |
| Top-changed dir | `apps/pi-mom/` (42 files) |
| New top-level dirs | `docs/research/2026-05-10/` (foundation research archive, 18 files) |

## PR #24 — foundation-v2 → main (the only substantive PR)

Merged 2026-05-12 16:01Z. 10 stages, all live-canaried on `covent-pi-mom-v2`:

| Stage | Commit | Landed |
|---|---|---|
| 0 | `1996ae1` → `3cff383` | pkg rename `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent@^0.74.0`; Node 22 → bun 1.3.11; bolt/Pi/bun smoke test |
| 1 | `5d9a59c` → `dcee88f` | `lib/pi-sdk-runner.mjs` (in-process SDK), replaces `spawn("pi", …)` |
| 2 | `9a2831d` | `lib/dispatch.mjs` (surface-aware); Bolt `Assistant` container + `app_mention` parity |
| 3 | `262c970` | Per-thread Pi session resumption (`lib/pi-session.mjs` + `lib/thread-session-map.mjs`) |
| 4 | `2e1c938` | Per-Action tool gating from `apps/pi-mom/control-plane/registry.yaml` + `lib/action-resolver.mjs` |
| 5 | `d7a5367` / `5425a87` / `75237d1` | `lib/slack-sink.mjs` (`chat.appendStream` + heartbeat + rotation) |
| 6 | `eb8a6e2` / `8c8cbef` | `lib/slack-ui-context.mjs` — Pi `ExtensionUIContext` → Slack modals |
| 6.5 | `8f00fc5` | `extensions/permission-gate.ts` wired; `bash:` route as natural canary |
| 7 | `cf8c4e8` / `9ab68fa` | `lib/home-view.mjs` — App Home cockpit (approvals snapshot, push-on-state-change) |
| Linear pivot | `f0dcfe3` / `3e9771c` | `extensions/linear-tools.ts` — `linear_search_issues` + `linear_create_issue` + `linear_add_comment` |
| 8 | `baf219c` / `7010054` | `lib/canvas-sink.mjs` mirrors `spec:` into a Slack canvas (+ hotfix for 404/access) |
| 9 | killed | image-gen route + `openai-image-tools` deleted (`81b1f3b`) |
| 10 | `a75858f` | Delete legacy paths (`agent-run-card`, `agent-run-store`, `agent-runners`, `slack-canvas`, `digest:`/`escalation:`/`agent:`/`uictx:` routes); plain route gets full default toolset |

`a75858f` (Stage 10) alone is ‑1,204 / +112 across 16 files and shrinks `apps/pi-mom/index.mjs` from 1,133 → 799 LOC.

## Code quality — recent code

Spot-checked the new modules under `apps/pi-mom/lib/` and the touched extensions:

- **`pi-sdk-runner.mjs`** — clean. Module-load preflight (`PI_OFFLINE=1` default, `PI_AGENT_DIR` → `PI_CODING_AGENT_DIR` alias, `PI_AUTH_JSON_B64` seed) is explicit and well-commented. Seed file written `0600` under a `0700` parent; never overwrites an existing `auth.json` (correct — SDK rotates the refresh token on every call). Token timeout, abort handling, sink fan-out, and tool-gating all wired through one `createRunner` factory; DI-friendly for unit tests.
- **`canvas-sink.mjs`** — well-reasoned. The header comment encodes the Slack canvas API foot-guns (1 op per call, Tier 3 rate limit, no native stream helper, no Block Kit, title-flip = pseudo-lock) so future readers don't re-discover them. 3s / 1.5KB debounce, rate-limit re-arm with `setTimeoutFn(rateLimitBackoffMs)` (no tight loop), single `replace` op at stop, fail-soft if create fails (`stopped = true`, handle/stop become no-ops). Access grant is best-effort and traces failures.
- **`registry.yaml`** — single source of truth for per-route `tools` / `systemPromptSuffix` / `approvals`. The schema is documented inline and in the new `docs/specs/registry-yaml-schema.md` (PR #25).
- **`extensions/linear-tools.ts`** — three composable tools with `errorResult()` helper (introduced to fix an `AnyResult.details: any` ↔ `AgentToolResult<any>.details: any (required)` drift). Redaction on outbound error text covers `lin_api_…` and `Authorization:`. Minor stylistic note: Linear's `Authorization` header is the raw API key, no `Bearer ` prefix — works (Linear accepts both forms) but is non-conventional.
- **`index.mjs`** — still 799 LOC but coherent post-Stage-10. The `pendingApprovals.set/delete` monkey-patch (lines 496-507) cleanly fires Home view republishes without leaking the cockpit concern into `slack-ui-context.mjs`. `redactSensitiveText` covers Slack/OpenAI/Linear token shapes plus generic `Authorization:` headers.

## Tests + validators

After `bun install --frozen-lockfile` (740 packages):

```
$ bun run check
secret-scan: ok
validate:skills ok (56 skills, 7 warnings)
validate:agents ok (15 agents, 9 warnings)
13 pi-mom test suites — all passing
tsc --noEmit — clean
```

Plus `packages/pi-ext-covent-aws` suite: 24 pass, 0 fail.

The 7 + 9 validator warnings (missing `description` / `defaultContext`) are pre-existing and not in the 24h diff. One stands out as a small follow-up: `agents/linear-auditor.md` duplicates `.pi/agents/linear-auditor.md` — pick one.

## Security review

| Item | Status |
|---|---|
| `gitleaks detect --source .` | clean |
| Custom `scripts/secret-scan.sh` patterns | clean |
| `.gitignore` coverage | covers `.env`, `.env.*` (except `.env.example` / `.env.template`), `*.secret`, `secrets/`, `mcp.json`, `sessions/`, `transcripts/`, `apps/pi-mom/.env.local`, Slack local config, Chrome profile, HAR files |
| `.gitleaks.toml` allowlist | only placeholder patterns (`xoxb-placeholder`, `xapp-...`, `sk-placeholder`) — no overrides hiding real secrets |
| OAuth seed (`PI_AUTH_JSON_B64`) | `auth.json` written with mode `0600`, parent dir `0700`, JSON-validated before write, never clobbers existing file (`b6ee3e3`) |
| Slack token redaction in stream/output | `redactSensitiveText` in `index.mjs` covers `xoxb-`/`xapp-`/`xoxe.`/`sk-proj-`/`sk-`/Linear `lin_api_`/Bearer headers/`slackauthticket`/`(SLACK\|OPENAI\|LINEAR)_*=value` env-style pairs |
| Permission-gate scope | `rm -rf`, `sudo`, `chmod`/`chown 777` only. Anything else on the `bash` / `plain` routes executes without prompting |
| `plain` route blast radius | Full default Pi toolset (`bash`, `read`, `grep`, `find`, `edit`, `write`) on bare `@Covent-Agent` mentions; gated only by `SLACK_ALLOWED_CHANNEL_ID` + `EXPECTED_SLACK_BOT_USER` preflight |
| Outstanding secret rotation | **Open.** PR #24 body: "Rotate exposed secrets (`OPENAI_API_KEY`, `LINEAR_API_KEY`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN` — surfaced in earlier `railway variables --kv` dumps). Deferred per Jake's call." |
| Linear team/project/state UUIDs in `index.mjs` (lines 50-52) | Hardcoded as fallback constants. Not secrets, but personally identifying — fine inside a private repo, would be a leak if the repo ever opens. |
| `tsconfig.json` `strict: false` | Deliberate (allowJs + checkJs is on permissive defaults), but type narrowing on the SDK boundary is minimal. The Stage 10 `errorResult` fix in `linear-tools.ts` is a concrete example of the kind of drift this allows. |

No new secret-shaped strings were introduced in the 24h diff. The only real-looking `lin_api_` / `xoxb-` substrings in the tree are in tests (`test-linear-tools.mjs`, `test-bun-compat.mjs`) and docs (`README.md`, runbooks) and are either explicit placeholders or fakes (`lin_api_TEST`, `xoxb-fake`).

## CI

`.github/workflows/ci.yml` runs on every PR + push to `main`/`foundation-v2`:

1. checkout w/ `fetch-depth: 0` (full history for gitleaks).
2. `oven-sh/setup-bun@v2` at `1.3.11`; `actions/setup-node@v6` at 22 (for tsc only).
3. `bun install --frozen-lockfile`.
4. `gitleaks/gitleaks-action@v2` (full-history scan).
5. `bun run check` — secret-scan + validators + 13 pi-mom suites + `tsc --noEmit`.
6. Parallel job: typecheck + `bun test` in `packages/pi-ext-covent-aws`.

`concurrency.cancel-in-progress` is enabled for PR events only, so post-merge runs don't cancel each other. `permissions: contents: read` is tight. Looks good.

## Open dependabot PRs to triage

| # | Bump | Risk |
|---|---|---|
| #10 | `typescript` 5.9.3 → 6.0.3 | Major. Will likely surface type errors against the SDK types. Hold until intentionally migrated. |
| #22 | `@types/node` 22 → 25 | Major. Mostly safe but worth a CI run before merging. |
| #23 (already closed without merge) | `yaml` 2.8.4 → 2.9.0 (root) | Minor — note that #21 (the pi-mom sibling) was merged. Closing #23 leaves only root unchanged; verify intent. |

## Concrete follow-ups (none blocking)

1. **Rotate the four secrets** flagged in PR #24's known-follow-ups section — `OPENAI_API_KEY`, `LINEAR_API_KEY`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`. They were surfaced in earlier `railway variables --kv` dumps and are still active.
2. **Tighten `plain` route blast radius** — consider gating `bash` on `plain` behind the same Slack approval modal that `bash:` uses, or restrict plain-route tools to read-only (`read`, `grep`, `find`) and require an explicit `bash:` / `write:` prefix for mutating tools. Today, a bare `@Covent-Agent rm -rf /tmp/foo` would still hit `permission-gate` (matches `\brm\s+(-rf?|--recursive)`), but any other destructive command — `mv`, `truncate`, `tee >`, `> /dev/sda`, `dd`, `:(){:|:&};:`, etc. — executes silently.
3. **De-duplicate `agents/linear-auditor.md`** with `.pi/agents/linear-auditor.md` (validator warning since before this window, but the merge added scrutiny to the agent surface).
4. **Decide on dependabot #10 + #22** — keep open / close / merge.
5. **Move Linear `TEAM_ID` / `PROJECT_ID` / `STATE_ID` defaults out of `index.mjs`** into the env-only path (still readable from `.env.example` for the team). Removes the only quasi-identifying UUIDs from source.

## Bottom line

A genuinely impressive 24 hours of work: the rebuild from subprocess `pi` to in-process Pi SDK is a category change, not a refactor, and it shipped with passing CI, live canary evidence on `covent-pi-mom-v2`, and a follow-up docs PR (#25) that catches the documentation up to the new reality. The codebase is in a notably better shape than it was 24h ago — fewer LOC, fewer routes, fewer envs, fewer foot-guns, more tests. The two real action items are the secret rotation (acknowledged, deferred) and the `plain`-route blast-radius decision (new since Stage 10).
