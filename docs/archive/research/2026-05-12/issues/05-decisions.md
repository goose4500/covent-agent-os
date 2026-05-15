> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# Decisions: plain-route blast radius, retire `/thread-spec`, dependabot triage

**Type**: `decision`
**Source**: 2026-05-12 24h audit + first-principles audits; open dependabot PRs (#10, #22).
**Surface**: `apps/pi-mom/control-plane/registry.yaml` (plain route), `extensions/permission-gate.ts` (gate patterns), `apps/pi-mom/index.mjs` (slash command + natural-language intent parser), dependabot PRs #10/#22.
**Risk**: Discussion-first issue. No code lands until each sub-decision is made.

## Context

Three open questions remain after the foundation-v2 rebuild that aren't bugs and aren't obvious one-way doors. They each need a deliberate "we picked this because …" before code changes. The cost of deciding is one focused thinking session per item; the cost of *not* deciding is drift (or a future regression because nobody knew the previous policy).

## Why

From the audits:
- **Plain-route blast radius** (24h audit, security review): Bare `@Covent-Agent` mentions now activate the full default Pi toolset (`bash`, `read`, `grep`, `find`, `edit`, `write`); the only safety nets are `SLACK_ALLOWED_CHANNEL_ID` (channel allowlist) and `permission-gate`'s three regex patterns (`rm -rf` / `sudo` / `chmod|chown 777`). Anything else destructive (`mv`, `dd`, `tee >`, `truncate`, `: > /dev/sda`, etc.) executes silently.
- **Retire `/thread-spec`** (Slack surface audit #11): Stage 10 collapsed the slash command's only remaining purpose to "kick off a spec from outside a thread by pasting a URL." The natural-language `app_mention` intent parser already handles the in-thread case; if we expand `parseSlackThreadReference` to fire on bare `app_mention` text with a Slack URL, `/thread-spec` is dead weight.
- **Dependabot triage** (24h audit): PR #10 (typescript 5.9.3 → 6.0.3, major) and PR #22 (`@types/node` 22.19.17 → 25.7.0, major) are sitting open. Major-version bumps shouldn't sit indefinitely; they either get merged (with a CI green-light) or closed (with a documented "not yet" rationale).

## Sub-decisions

### 1. Decide plain-route blast radius

**The question**: Is a bare `@Covent-Agent <free text>` mention safe enough with today's two guards (channel allowlist + 3-pattern permission-gate), or do we need a stronger default?

**Options to weigh**:

- **A. Status quo** — Keep `plain` tools as `[bash, read, grep, find, edit, write]`. Document the threat model explicitly: only operators in the configured channel can mention; permission-gate handles the four most destructive patterns; anything else is "as if the operator typed it themselves on the bot's host."
- **B. Read-only by default** — Strip `bash` / `edit` / `write` from the `plain` route, leaving `[read, grep, find]`. Require an explicit `bash:` / `edit:` prefix (or new `mutate:` route) for any state-changing action. Plain mentions become "ask Pi to inspect / answer / draft" only.
- **C. Modal-gate every `bash` invocation on the plain route** — Wider permission-gate scope: any `bash` tool_call on the `plain` route hits the Slack approval modal, regardless of command pattern. Operator sees the command, taps Approve. `bash:` route (explicit prefix) keeps today's per-pattern gating.
- **D. Hybrid** — Plain route = `[read, grep, find]`; `bash:` prefix activates today's `[bash]` with permission-gate; new `mutate:` prefix activates `[edit, write, bash]` with permission-gate. Three tiers, prefix-gated.

**Recommendation default (mine)**: **C**. The plain-route was widened to enable real work; narrowing it back to read-only undoes Stage 10's intent. But "default to approval modal on every `bash`" preserves the breadth while restoring the trust gate that today's pattern-only check skips for everything that isn't one of the four dangerous shapes.

**Decision deliverables**:
- [ ] Pick one of A/B/C/D (or define E with rationale).
- [ ] If not A: update `apps/pi-mom/control-plane/registry.yaml:62-65` (plain route `tools` array) and/or `extensions/permission-gate.ts:11` (`dangerousPatterns`) accordingly.
- [ ] Document the chosen threat model in `BOUNDARY.md` or a new `docs/specs/plain-route-policy.md`.
- [ ] Update `apps/pi-mom/README.md` examples to reflect the new behavior.

### 2. Decide whether to retire `/thread-spec`

**The question**: Does the slash command still earn its keep after Stage 10?

**Today (`apps/pi-mom/index.mjs:609-667`)**:
- `/thread-spec <Slack URL> [optional focus]` parses the URL, validates it's in the allowed channel, dispatches a `spec:` route into that thread.
- Only required when the user wants to kick off a spec from *outside* the target thread. In-thread, the user already says `@Covent-Agent draft a spec` (handled by `parseThreadSpecIntent` at `index.mjs:122-145`).

**Options**:

- **A. Keep as-is** — Cheap to maintain; slash commands have muscle memory for some users.
- **B. Retire after expanding natural-language parser** — Update `parseSlackThreadReference` (`index.mjs:179-203`) so it fires on bare `app_mention` text. If a user's mention contains a Slack permalink, parse it and treat the message as a spec request against the referenced thread. Then delete `/thread-spec`, the `app.command` handler, and the slash command config from the Slack app manifest.
- **C. Soft-deprecate** — Keep the command but reply with "Use `@Covent-Agent spec: <Slack URL>` instead — slash command will be removed on YYYY-MM-DD." Migrate users for one cycle, then delete.

**Recommendation default (mine)**: **B**, but only after the natural-language parser change ships and runs for ~1 week without surprises.

**Decision deliverables**:
- [ ] Pick A/B/C.
- [ ] If B or C: open a follow-up issue specifically for the parser expansion + (later) the command deletion + manifest update.

### 3. Triage dependabot PRs #10 and #22

**PR #10** (`dependabot/npm_and_yarn/typescript-6.0.3`): typescript `5.9.3` → `6.0.3`. Major version. Risk: type errors against the Pi SDK + Bolt + web-api type defs; possible new strictness defaults.

**PR #22** (`dependabot/npm_and_yarn/types/node-25.7.0`): `@types/node` `22.19.17` → `25.7.0`. Major version. Risk: minor (`@types/node` major bumps mostly track Node release lines and add new types, rarely remove). Could surface `lib` mismatches if `tsconfig.json` `target/lib` isn't aligned.

**Options per PR**:

- **A. Merge if CI green** — Cheapest path; trust the existing test suite + `tsc --noEmit`.
- **B. Hold with rationale** — Pin to current; close the PR with a comment ("Holding because <reason>; revisit when <trigger>"). For #10 specifically: TS 6.x's stricter `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` defaults could be a wider sweep than we want right now.
- **C. Bump to an intermediate version** — e.g. TS 5.9.x → 5.x latest stable that still avoids the major bump.

**Recommendation defaults (mine)**:
- #22 (`@types/node` 25): **A — merge if CI green**. Low risk, repo doesn't pin tight Node-API contracts.
- #10 (TS 6.0.3): **B — hold**. The audit's `tsconfig.json` `strict: false` finding means we're already lax; bumping TS major would either reset us to baseline (good) or surface ~50 errors in one shot (annoying). Either way, do it deliberately on a dedicated branch, not via dependabot autoland.

**Decision deliverables**:
- [ ] Merge or close #22 with a comment in the PR.
- [ ] Merge or close #10 with a comment in the PR.

## Acceptance criteria

- [ ] Plain-route blast radius decision documented (option chosen, rationale, where the policy lives).
- [ ] `/thread-spec` decision documented (keep / retire / soft-deprecate).
- [ ] Both dependabot PRs (#10, #22) either merged or closed with explicit rationale in a PR comment.
- [ ] Each decision references this issue when it's closed.

## Out of scope

- Implementing any of the above. This is a decisions issue. Once decisions land, implementation goes into separate issues / PRs.
- Other dependabot PRs that may arrive after this issue is opened — same triage shape will apply; reference this issue's framework when they appear.

## References

- 24h audit: `docs/research/2026-05-12/audit-24h.md` (concrete follow-ups #2, #4 + security-review table).
- Slack surface audit #11 (`/thread-spec` retirement).
- Open PRs: https://github.com/goose4500/covent-agent-os/pull/10, https://github.com/goose4500/covent-agent-os/pull/22.
- `apps/pi-mom/control-plane/registry.yaml:62-65` — plain route tools.
- `extensions/permission-gate.ts:11` — dangerous patterns.
- `apps/pi-mom/index.mjs:609-667` — slash command handler.
- `apps/pi-mom/index.mjs:179-203` — `parseSlackThreadReference`.
