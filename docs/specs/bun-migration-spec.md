# Spec: Bun Runtime Migration

Status: proposed / source-of-truth execution spec
Created: 2026-05-08
Branch: `feat/bun-migration-spec` (lands on `main`)
Repo: `goose4500/covent-agent-os`
Sibling spec: `docs/specs/boring-high-leverage-refactor-spec.md`
Purpose: give a single durable contract for migrating the Covent Agent OS from npm/Node tooling to Bun, while preserving the Pi runtime contract that pins a subset of the repo to Node forever.

## Executive summary

This repo is unusually clean for a Bun migration. There are zero native modules, zero accidental `Bun.*` usage today, every `node:*` import is properly prefixed, and the only "test" is a 73-LOC hand-rolled `node:assert` script. A full audit (whole-repo + Pi-runtime + apps/pi-mom-deep) found no blocking issues.

The migration is not "Bun is faster than Node." The leverage is collapsing three toolchains (npm + tsc-driven typecheck + node-test-harness) into one binary, replacing the 180KB `package-lock.json` with a reviewable text `bun.lock`, and unlocking `bun test` so the Slack worker stops being write-only code. The single highest-leverage move is Phase 5: replacing the `node --check && node test-…` smoke-alarm pipeline with real `bun test` coverage on the worker routes.

The non-negotiable boundary is **Pi's runtime contract**: `@mariozechner/pi-coding-agent` ships with shebang `#!/usr/bin/env node` and loads extensions in-process via jiti. There is no advertised support for running `pi` itself under Bun. Therefore everything in `pi.extensions[]` (and its transitive imports) must remain Node-portable. This spec calls that the **Node-only fence**, lists exactly which files belong to it, and prescribes a CI tripwire that prevents drift.

## Read-first context path for future agents

Read in order before touching code on this track:

1. `docs/SYSTEM_INDEX.md` — source-of-truth hierarchy.
2. `docs/AGENT_CONTEXT.md` — operational context for Covent Pi / pi-mom.
3. `BOUNDARY.md` — authority/mutation boundaries.
4. `SECURITY.md` — secret handling rules.
5. `docs/architecture.md` — compact architecture model.
6. `docs/specs/boring-high-leverage-refactor-spec.md` — sibling refactor track this spec coordinates with.
7. Existing ADRs under `docs/adr/`.
8. This spec.
9. Code:
   - `package.json` (root) and `apps/pi-mom/package.json`, `packages/pi-chrome-access/package.json`
   - `tsconfig.json`
   - `railway.toml` and `apps/pi-mom/railway.toml`
   - `extensions/*.ts`
   - `packages/pi-chrome-access/extensions/chrome-access.ts`
   - `apps/pi-mom/index.mjs` and `apps/pi-mom/lib/*.mjs`
   - `lib/*.mjs`
   - `scripts/*.mjs` and `scripts/*.sh`
   - `.github/workflows/ci.yml`

If docs and code disagree, code is implementation truth. Preserve current production behavior unless explicitly asked otherwise.

## Goals

In priority order:

1. **Adopt Bun as the host runtime, package manager, test runner, and script runner** for all repo surfaces that are not loaded by Pi.
2. **Codify the Pi runtime fence** as a CI-enforced invariant so future agents cannot accidentally introduce `Bun.*` APIs into Pi-loaded code.
3. **Replace the npm/Node tooling on Railway** with Bun, keeping the Slack Socket Mode worker behaviorally identical.
4. **Replace the hand-rolled `node:assert` test pipeline** with `bun test` and use the cheaper test ergonomics to grow real coverage on `apps/pi-mom/index.mjs`.
5. **Update all human-facing documentation** (`README.md`, `LOCAL_DX.md`, runbooks, ADRs) to reflect Bun as the canonical local DX.
6. **Preserve existing behavior of the Slack worker** — every Slack route, every Pi spawn, every Linear/OpenAI side effect must produce identical output before/after migration.

## Non-goals

- Migrating Pi itself, Pi extensions, or `packages/pi-chrome-access/` to Bun. Those stay Node-portable.
- Migrating skills' Python/shell scripts (already runtime-neutral; not Pi's runtime).
- Adopting Bun-only APIs (`Bun.sql`, `Bun.serve`, `Bun.file`) inside Pi-loaded code, even when transitively safe.
- Adding new product surface area (Slack routes, Linear flows, agent kits) under this track. Feature work belongs to the work branches; this track is tooling.
- Removing TypeScript or `tsc`. Bun's typechecking story is "delegate to `tsc`" — `bunx tsc --noEmit` continues to be the typecheck command.
- Pushing the migration to `origin/main` or a Railway production deploy. This spec scopes the local plan; deploy is a follow-up gated on Phase 4 verification.

## Pi runtime constraint (the durable boundary)

### Hard facts (verified in `node_modules/@mariozechner/pi-coding-agent/`)

- `package.json:9-11` declares `"bin": { "pi": "dist/cli.js" }`.
- `dist/cli.js:1` shebang is `#!/usr/bin/env node`.
- `package.json:97-99` declares `"engines": { "node": ">=20.6.0" }`. No `bun` engine.
- `dist/core/extensions/loader.js:14,271-278` imports `createJiti from "jiti/static"` and calls `jiti.import(extensionPath, { default: true })` **in-process**. Extensions share Pi's process memory and module graph.
- Extensions are not spawned as child processes. They run inside the Node `pi` host.
- A `dist/bun/cli.js` exists but is for `bun build --compile` packaging, not for end users running the npm-installed `pi` under Bun.

### What this means

| Category | Loaded by Pi? | Must be Node-portable? |
|---|---|---|
| Files listed in `pi.extensions[]` (root `package.json:25-31`) | yes (jiti) | yes |
| Files in `packages/*/extensions/*.ts` declared as Pi extension packages | yes (jiti) | yes |
| Files imported by any of the above | yes (transitive) | yes |
| `apps/pi-mom/**` (separate Node process, spawns `pi` CLI as child) | no | no |
| `scripts/*.mjs` (dev-time validators, run via package script) | no | no |
| `tests/`, `examples/`, `agent-kits/`, `prompts/`, `agents/`, `.pi/agents/` (`.md`/`.json`/`.html` content) | no (data, not code) | n/a |
| Skills' `.py` and `.sh` scripts (Pi `bash`-execs them under their own shebangs) | no (subprocess, not in-process) | n/a |

### Three zones (canonical)

**Node-only fence** (must stay Node-portable; no `Bun.*`, no `bun:*` imports):

- `extensions/env-guard.ts`
- `extensions/git-checkpoint.ts`
- `extensions/linear-mcp-guard.ts`
- `extensions/permission-gate.ts`
- `extensions/slack-mcp-guard.ts`
- `extensions/openai-image-tools.ts` (currently unregistered in `pi.extensions` but author intent is a Pi extension; treat as fenced to preserve the option)
- `extensions/browser-use-tools.ts` (same status as above)
- `lib/openai-image-client.mjs` (transitively imported by `extensions/openai-image-tools.ts:3`)
- `lib/browser-use-client.mjs` (transitively imported by `extensions/browser-use-tools.ts:3`)
- `packages/pi-chrome-access/extensions/chrome-access.ts`
- Any future file added to any `pi.extensions[]` array, plus its transitive imports.

**Bun-safe zone** (free to use Bun runtime, `Bun.$`, `bun test`, `bun:sqlite`, etc.):

- `apps/pi-mom/**`
- `scripts/*.mjs`
- `tests/**`, `examples/**`, `agent-kits/**`
- Root `package.json` scripts
- Anywhere not listed in the Node-only fence.

**Runtime-neutral** (data, not code; or executes under its own shebang):

- `skills/**/*.md|.json|.html|.txt` (prompt content)
- `skills/**/scripts/*.py|.sh` (own shebangs / uv)
- `agents/**/*.md`, `prompts/**/*.md`, `.pi/agents/*.md`

### Tripwire pattern

`extensions/env-guard.ts:1` already carries the canonical signage:

```ts
// node-compat: no Bun APIs — Pi's jiti loader runs extensions under Node
```

This spec mandates replicating that comment as the first line of every file in the Node-only fence (10 files) so future agents see the constraint before reading the code.

## Validated baseline (audit findings)

### Runtime-coupling inventory

Every file's `node:*` imports are in the Bun-supported builtins set. No file imports a non-prefixed builtin (`require("fs")`, `require("path")`).

| File | `node:*` imports | Bun status |
|---|---|---|
| `apps/pi-mom/index.mjs` | `child_process`, `fs`, `fs/promises`, `os`, `path` | ✓ |
| `apps/pi-mom/doctor.mjs` | `child_process` (spawnSync) | ✓ |
| `apps/pi-mom/lib/agent-runners.mjs` | `child_process`, `crypto`, `timers/promises` | ✓ |
| `apps/pi-mom/lib/agent-run-store.mjs` | `fs/promises`, `path` | ✓ |
| `apps/pi-mom/lib/openai-image-client.mjs` | `fs/promises`, `os`, `path` | ✓ |
| `apps/pi-mom/test-agent-run-card.mjs` | `assert/strict`, `fs/promises`, `os`, `path` | ✓ |
| `lib/openai-image-client.mjs` | `fs/promises`, `os`, `path` | ✓ (Node-fenced) |
| `lib/browser-use-client.mjs` | `fs`, `fs/promises`, `os`, `path` | ✓ (Node-fenced) |
| `scripts/scaffold-agent.mjs` | `fs/promises`, `path` | ✓ |
| `scripts/validate-agents.mjs` | `fs/promises`, `path` | ✓ |
| `scripts/validate-skills.mjs` | `fs/promises`, `path` | ✓ |
| `packages/pi-chrome-access/extensions/chrome-access.ts` | `fs`, `fs/promises`, `os`, `path` | ✓ (Node-fenced) |
| `extensions/*.ts` (5 registered) | none beyond `type ExtensionAPI` | ✓ (Node-fenced) |

`Buffer.from` is used at `apps/pi-mom/index.mjs:484` and the `*-image-client.mjs` files — global on Bun, no change. Global `fetch` already used everywhere — Bun-native.

### Native-module risk list

Across all three `package.json` files:

| Dep | Risk |
|---|---|
| `@slack/bolt ^4.6.0` | Pure JS. Bun-compatible. |
| `@slack/web-api` (transitive, used directly at `apps/pi-mom/index.mjs:2`, `doctor.mjs:2`, `test-*.mjs`) | Pure JS. **Currently undeclared** — must add explicitly in Phase 0. |
| `@mariozechner/pi-coding-agent ^0.73.1` | Pi runtime, runs on Node. We never invoke it as a Bun host process; we either `import type` from it (extensions) or `spawn()` the `pi` CLI binary. Safe. |
| `@types/node ^22.15.3` | Types only. |
| `typebox` | Pure JS / TypeScript. |
| `typescript ^5.9.3` | Run via `bunx tsc`. |
| `pi-chrome-access` peer deps | Resolved by Pi host, not this repo. Out of scope. |

**Zero risky native modules.** No `better-sqlite3`, `sharp`, `bcrypt`, `node-pty`, `fsevents`, `canvas`, `node-gyp`. This is the easiest possible Bun migration on the dependency front.

### Package-manager coupling (every npm reference)

| File:line | Reference | Bun replacement |
|---|---|---|
| `package.json:12-16` | `npm run X && npm --prefix apps/pi-mom Y` | `bun run X && bun --filter covent-pi-mom Y` |
| `apps/pi-mom/package.json:11` | `node --check && node test-…` | `bun test` (after Phase 5) or `bun --check && bun test-…` interim |
| `apps/pi-mom/package.json:engines.npm:>=10` | npm engine pin | drop |
| `railway.toml:9` | `startCommand = "npm run dev:pi-mom"` | `startCommand = "bun run dev:pi-mom"` |
| `apps/pi-mom/railway.toml:6,9` | `npm ci`, `npm start` | `bun install --frozen-lockfile`, `bun run start` |
| `.github/workflows/ci.yml:13-16` | setup-node, npm ci, npm run check | setup-bun, bun install --frozen-lockfile, bun run check |
| `scripts/install-local.sh:10` | `npm run check` | `bun run check` |
| `scripts/secret-scan.sh:17-19` | excludes `package-lock.json` | also exclude `bun.lock` |
| `apps/pi-mom/lib/agent-runners.mjs:42` | `command: "npm", args: ["--prefix","apps/pi-mom","run","check"]` | `command: "bun", args: ["--filter","covent-pi-mom","run","check"]` |
| `apps/pi-mom/test-agent-run-card.mjs:58` | `assert.deepEqual(commands, [..., "npm --prefix apps/pi-mom run check"])` | **Coupled change** — must update in lockstep with `agent-runners.mjs:42` |
| `apps/pi-mom/test-bridge-online.mjs:42` | log string mentions `npm start` | cosmetic |
| `apps/pi-mom/README.md:146` | doc string of the spawn command | doc-only |

### Workspace shape (translates cleanly)

| package.json | name | type | engines | Notes |
|---|---|---|---|---|
| `/package.json` | `covent-agent-os` | module | `node >=22 <25` | private, `workspaces:["apps/pi-mom","packages/*"]`. Devs: pi-coding-agent, @types/node, typebox, typescript. |
| `apps/pi-mom/package.json` | `covent-pi-mom` | module | `node >=22 <25, npm >=10` | deps: `@slack/bolt`, pi-coding-agent. **Implicit `@slack/web-api` dep** must be made explicit. |
| `packages/pi-chrome-access/package.json` | `pi-chrome-access` | module | none | private, peer-deps only (resolved by Pi host). |

Bun supports the same `workspaces:[...]` syntax. `bun.lock` (text format, ≥ 1.1.18) replaces `package-lock.json`.

### Documentation drift

13 files prescribe `npm install`/`npm run` and need updating. Listed in Phase 6.

## What Bun unlocks for this codebase

| Today | After migration | Net leverage |
|---|---|---|
| `tsc --noEmit` for typecheck | `bunx tsc --noEmit` | None — tsc is the typechecker. Bun delegates. |
| `node test-agent-run-card.mjs` (1 file, manual, sequential) | `bun test` (parallel, watch, coverage) | Real — unblocks adding tests cheaply on `apps/pi-mom/index.mjs` routes |
| `npm install` + `package-lock.json` (180KB binary-ish) | `bun install` + `bun.lock` (text, ~30KB) | Real — review-able diffs, ~10–25× install speed on cold cache |
| `node --check apps/pi-mom/*.mjs` (syntax-only smoke alarm) | Replaced by `bun test` real assertions | Real — current `check` script is theatre, not a test |
| `child_process.spawn("npm", ["--prefix",...])` for repo-health route | `Bun.$\`bun --filter covent-pi-mom run check\`` (optional) | Marginal — better ergonomics, same correctness |
| `scripts/*.mjs` validators run via `node` | Could become single-file Bun scripts (shebang `#!/usr/bin/env -S bun run`) | Marginal — one less tool to remember |
| Railway NIXPACKS detects Node | NIXPACKS detects Bun on `bun.lock` (Nixpacks ≥ v1.21) | Real — faster cold builds |

The single highest-leverage move is Phase 5 (real `bun test` coverage on the Slack worker). Phases 0–4 are tooling enablers that are individually small wins.

## Phased migration plan

Each phase is one PR. Each PR is independently revertible. No phase silently bundles the next.

### Phase 0 — Pre-flight (15 min)

**Scope**

- Add `"@slack/web-api": "^7.x"` (pin to whatever version `bolt 4.6.0` resolves it to today) to `apps/pi-mom/package.json` deps.
- Add the `// node-compat: no Bun APIs` comment as the first line of all 10 Node-only-fence files (currently only `extensions/env-guard.ts:1` has it).
- Run `npm run check` to baseline green.

**Exit criterion:** `npm run check` passes; `git diff --stat` shows only deps + comments.

### Phase 1 — Package manager swap, scripts unchanged (30 min)

**Scope**

- `bun install` — generates `bun.lock`.
- `rm package-lock.json`.
- Drop `engines.npm: ">=10"` from `apps/pi-mom/package.json`.
- Add root `"packageManager": "bun@1.3.11"` to `package.json`.
- `scripts/secret-scan.sh:19` — add `bun.lock` to glob excludes.
- **Do not touch any `npm run` script yet.** Bun executes npm scripts unchanged via `bun run`.

**Exit criterion:** `bun run check` passes locally. `git diff` is constrained to lockfile swap + 3 small config tweaks.

### Phase 2 — CI flip (10 min)

**Scope**

- `.github/workflows/ci.yml` — replace `actions/setup-node@v4` with `oven-sh/setup-bun@v2` pinned to `bun-version: 1.3.11`. Replace `npm ci` with `bun install --frozen-lockfile`. Replace `npm run check` with `bun run check`.

**Exit criterion:** GitHub Actions CI green on the PR.

### Phase 3 — Internalize Bun in scripts (1 hr)

**Scope**

- Root `package.json:11-23` — replace `npm --prefix apps/pi-mom` with `bun --filter covent-pi-mom`. Replace top-level `npm run` with `bun run`.
- `scripts/install-local.sh:10` — `bun run check`.
- **Coupled change (must land together in this PR):**
  - `apps/pi-mom/lib/agent-runners.mjs:42` — change `command: "npm"` → `command: "bun"`, args from `["--prefix","apps/pi-mom","run","check"]` → `["--filter","covent-pi-mom","run","check"]`.
  - `apps/pi-mom/test-agent-run-card.mjs:58` — update the `assert.deepEqual(commands, [...])` literal to match the new bun args. Without this update, the test fails on the next CI run.
  - `apps/pi-mom/README.md:146` — update doc string of the spawn command.

**Exit criterion:** CI green. `bun run check` passes locally. Repo-health agent route (which spawns the new `bun` command via `agent-runners.mjs`) returns success when triggered from Slack.

### Phase 4 — Railway (15 min, deploy required)

**Scope**

- `railway.toml:9` → `startCommand = "bun run dev:pi-mom"`.
- `apps/pi-mom/railway.toml:6,9` → `buildCommand = "bun install --frozen-lockfile"`, `startCommand = "bun run start"`.
- Verify Railway's NIXPACKS version supports Bun auto-detection on `bun.lock` (≥ v1.21). If not, add `nixpacks.toml` with `[providers] = ["bun"]` or commit a Bun Dockerfile based on `oven/bun`.

**Smoke test before merging the PR:**

1. Deploy to Railway preview environment (not production).
2. Confirm Socket Mode connect in `railway logs`.
3. From a test Slack channel, exercise: `@Covent Pi` echo, `@Covent Pi spec …` (in-thread spec route), `@Covent Pi create Linear issue`, repo-health route (`@Covent Pi check`), and one path that exercises `WebClient.chatStream` (`apps/pi-mom/index.mjs:810,820`). Confirm each round-trips identically.
4. Only after smoke tests are green, merge and let Railway auto-deploy production.

**Exit criterion:** Production worker reconnects in Socket Mode, `chatStream` round-trip succeeds, no error spike in Railway logs over a 30-minute observation window.

### Phase 5 — Test runner upgrade (1–2 hrs, optional but highest leverage)

**Scope**

- Convert `apps/pi-mom/test-agent-run-card.mjs` from `import { strict as assert } from "node:assert/strict"` to `import { test, expect } from "bun:test"`.
- Add `"test": "bun test"` to `apps/pi-mom/package.json`.
- Replace `apps/pi-mom/check` script's `node test-agent-run-card.mjs` with `bun test`.
- Land the test conversion alone first; then in a follow-up PR, add real route tests for `apps/pi-mom/index.mjs`: spec route, Linear-issue route, agent-run-card rendering. The point of Phase 5 is to make Phase 5+ cheap.

**Exit criterion:** `bun test` green. Then 3 new route tests added in follow-up PR.

### Phase 6 — Documentation sweep (30 min, mechanical)

**Scope:** replace `npm install`/`npm run` references in human-facing docs.

- `README.md` (10 occurrences)
- `LOCAL_DX.md` (5)
- `apps/pi-mom/README.md` (5)
- `SECURITY.md` (2)
- `docs/AGENT_CONTEXT.md` (8)
- `docs/SYSTEM_INDEX.md` (7)
- `docs/architecture.md` (3)
- `docs/runbooks/agent-kit-scaffold.md` (10)
- `docs/runbooks/covent-ec2-pi-agent-machine.md` (1)
- `docs/adr/0005-project-agent-kit-scaffold.md` (3)

Leave historical: `docs/history/pi-session-context-2026-05-07.md:50` and `MIGRATION_MAP.md:22`.

**Exit criterion:** `grep -rn "npm install\|npm run" README.md LOCAL_DX.md SECURITY.md apps/pi-mom/README.md docs/` returns only the two historical exceptions above.

### Never-migrate list (immutable)

Files that must remain Node-portable forever:

- `extensions/env-guard.ts`
- `extensions/git-checkpoint.ts`
- `extensions/linear-mcp-guard.ts`
- `extensions/permission-gate.ts`
- `extensions/slack-mcp-guard.ts`
- `extensions/openai-image-tools.ts`
- `extensions/browser-use-tools.ts`
- `lib/openai-image-client.mjs`
- `lib/browser-use-client.mjs`
- `packages/pi-chrome-access/extensions/chrome-access.ts`

## CI tripwires (mandatory after Phase 0)

Add to `.github/workflows/ci.yml` as a non-blocking but failing-grade step:

```bash
# Node-only fence: forbid Bun APIs in Pi-loaded code
! grep -rE 'Bun\.|"bun:' \
    extensions/ \
    packages/pi-chrome-access/extensions/ \
    lib/ \
  || (echo "ERROR: Bun.* / bun:* import found in Node-only fence"; exit 1)
```

If it ever fires, either the offending file should not have been added to `pi.extensions[]`, or the import should be removed.

## Verification gates per phase

| Phase | Gate command(s) | What "pass" looks like |
|---|---|---|
| 0 | `npm run check` | green; only deps + comment changes in diff |
| 1 | `bun run check` + `bun --version` ≥ 1.3.11 | green; `bun.lock` exists; `package-lock.json` removed |
| 2 | GitHub Actions on PR | green on first run after CI yml change |
| 3 | `bun run check` + manual `@Covent Pi check` from Slack | green; repo-health card returns success |
| 4 | Railway preview logs + 5 Slack route smoke tests | Socket Mode connects; all 5 routes round-trip |
| 5 | `bun test` | green; coverage > 0% on `apps/pi-mom/index.mjs` |
| 6 | grep audit (see Phase 6 exit criterion) | only historical exceptions remain |

## Rollback procedure

Every phase must remain revertible by `git revert <phase-commit>` without manual intervention. Specifically:

- **Phase 1 rollback:** `git revert` restores `package-lock.json`. Run `npm install` to regenerate `node_modules/`.
- **Phase 4 rollback:** `git revert` restores `npm` start commands. Railway redeploys on next push; previous build artifacts are not preserved, so the redeploy takes one normal cold-start cycle (~2–4 min).
- **Phase 5 rollback:** `bun test` reverts to `node --check && node test-…`. No production impact.

Cross-phase rollback (e.g., reverting Phase 3 while Phase 4 is live) is supported only when phases are reverted in reverse order. Do not skip-revert.

## Known gotchas

1. **`apps/pi-mom/test-agent-run-card.mjs:58` will hard-fail** the moment `agent-runners.mjs:42` swaps `npm` for `bun`. They must land in the same commit (Phase 3).
2. **`@slack/web-api` is undeclared** — currently riding transitively on `@slack/bolt`'s tree. Bun's installer can be stricter on phantom deps depending on configuration. Phase 0 fixes this.
3. **`spawn(PI_COMMAND, ...)` at `apps/pi-mom/index.mjs:731`** spawns the `pi` CLI as a child process. That child stays on Node. Mixing runtimes (Bun host, Node child for Pi) is the documented pattern in `~/.claude/projects/-home-jfloyd/memory/reference_pi_stack.md`. Do not "consolidate" by trying to run Pi under Bun.
4. **NIXPACKS Bun detection requires Nixpacks ≥ v1.21.** If Railway is pinned older, Phase 4 needs an explicit `nixpacks.toml` or a Bun Dockerfile. Verify the pinned Nixpacks version before Phase 4 starts.
5. **Active feature velocity on `apps/pi-mom/index.mjs`** (903 → 1351 LOC in 2 days as of 2026-05-08). This track should land before more `.mjs` surface area appears, or each new route adds Phase 6 doc work.
6. **`WebClient.chatStream`** at `apps/pi-mom/index.mjs:810,820` is a recent `@slack/web-api` helper. It is not exhaustively tested under Bun in the wild. Phase 4 smoke test must explicitly exercise it.

## Open questions

1. Should `extensions/openai-image-tools.ts` and `extensions/browser-use-tools.ts` be **registered** in `pi.extensions[]` (currently they're not, but their location and shape say "yes"), or are they internal-only? The answer determines whether `lib/openai-image-client.mjs` and `lib/browser-use-client.mjs` permanently live in the Node-only fence (yes, register) or could later move to the Bun-safe zone (no, drop them).
2. Should the spec runner replace `nixpacks` with a hand-rolled Dockerfile that uses `oven/bun` directly, to remove the implicit dependency on Nixpacks Bun-detection version? Tradeoff: reproducibility vs. one more file to maintain.
3. Does Railway's current Nixpacks version support Bun auto-detection? Verify before Phase 4.
4. After Phase 5, where does the test runner live for the Node-only fence? `bun test` cannot be used for files that ship to Pi. Recommendation: keep ext-fence tests under `tests/extensions/` and run them via `node --test`, with a separate CI step. (Currently no extension tests exist.)

## Appendix A: Full file inventory by zone

### Node-only fence (10 files)

```
extensions/env-guard.ts
extensions/git-checkpoint.ts
extensions/linear-mcp-guard.ts
extensions/permission-gate.ts
extensions/slack-mcp-guard.ts
extensions/openai-image-tools.ts
extensions/browser-use-tools.ts
lib/openai-image-client.mjs
lib/browser-use-client.mjs
packages/pi-chrome-access/extensions/chrome-access.ts
```

### Bun-safe zone (will be migrated)

Source files:
```
apps/pi-mom/index.mjs
apps/pi-mom/doctor.mjs
apps/pi-mom/lib/agent-runners.mjs
apps/pi-mom/lib/agent-run-store.mjs
apps/pi-mom/lib/agent-run-card.mjs
apps/pi-mom/lib/slack-canvas.mjs
apps/pi-mom/lib/openai-image-client.mjs
apps/pi-mom/test-agent-run-card.mjs
apps/pi-mom/test-bridge-online.mjs
apps/pi-mom/test-post.mjs
scripts/scaffold-agent.mjs
scripts/validate-agents.mjs
scripts/validate-skills.mjs
```

Config / deploy / docs:
```
package.json
apps/pi-mom/package.json
packages/pi-chrome-access/package.json
tsconfig.json
railway.toml
apps/pi-mom/railway.toml
.github/workflows/ci.yml
scripts/install-local.sh
scripts/secret-scan.sh
scripts/sync-from-live-pi.sh
README.md
LOCAL_DX.md
SECURITY.md
apps/pi-mom/README.md
docs/AGENT_CONTEXT.md
docs/SYSTEM_INDEX.md
docs/architecture.md
docs/runbooks/agent-kit-scaffold.md
docs/runbooks/covent-ec2-pi-agent-machine.md
docs/adr/0005-project-agent-kit-scaffold.md
```

### Runtime-neutral (no migration work)

```
skills/**            (.md content + own-shebang scripts)
agents/**            (.md prompts)
prompts/**           (.md prompts)
.pi/agents/**        (.md prompts)
docs/source-of-truth/**, docs/history/**  (.md)
examples/**, agent-kits/**  (.md and template files)
```

## Appendix B: Coupled-change matrix

Some changes must land in the same commit or CI breaks. This is the canonical list:

| Change A | Change B | Reason |
|---|---|---|
| `apps/pi-mom/lib/agent-runners.mjs:42` (`npm` → `bun`) | `apps/pi-mom/test-agent-run-card.mjs:58` (assertion literal) | Test asserts the exact spawn args. |
| `package-lock.json` removal | `bun.lock` addition | One must replace the other; CI fails if neither is present. |
| `railway.toml:9` change | `apps/pi-mom/railway.toml:6,9` change | Both files must agree on the runtime; Railway uses both. |
| CI workflow change | Local `bun.lock` commit | `bun install --frozen-lockfile` fails without a committed lockfile. |
| Adding any file to `pi.extensions[]` | Comment `// node-compat: no Bun APIs` on that file's first line + tripwire grep update | Prevent drift into the fence. |

## Appendix C: Decision provenance

This spec was derived from a three-agent audit run on 2026-05-08:

- **Whole-codebase audit** (`gemini-agent`-class, internal): runtime-coupling inventory, package-manager coupling, workspace shape, native-module risk list, doc drift, phased migration order.
- **Pi runtime contract investigation** (`general-purpose`): confirmed `pi-coding-agent` shebang, jiti loader behavior, extension import graph, defined the three zones.
- **`apps/pi-mom` Bun-readiness deep read** (`general-purpose`): per-file Node-ism inventory, Slack lib compat, subprocess surface, Railway deploy specifics.

Each finding in the validated baseline is traceable to one of those three reports. If the audit is re-run later and a finding diverges, this spec is the artifact to update.
