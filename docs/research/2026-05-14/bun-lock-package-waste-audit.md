# `bun.lock` package waste audit

Date: 2026-05-14  
Repository: `goose4500/covent-agent-os`  
Base audited: `origin/main` at `f3490d3` (`Merge pull request #85 from goose4500/docs/archive-rotted-context`)  
Runtime tested: Bun `1.3.11`, Linux arm64/WSL2

## Executive summary

The lockfile is not mostly stale junk. Most entries are explained by the repo's current architecture:

- embedded Pi SDK: `@earendil-works/pi-coding-agent`
- Slack worker runtime: `@slack/bolt` + `@slack/web-api`
- default-on agent capabilities: `pi-subagents`, `pi-web-access`, `pi-mcp-adapter`

There is still actionable waste / cleanup:

1. **`typebox` is misclassified as a dev dependency.** Runtime extension files import it, so `bun install --production` currently breaks the app test suite.
2. **`--omit optional` is safe in the tested headless worker install path** once `typebox` is moved to production dependencies. This removes about **33 MB** of native/TUI optional packages while keeping the app tests green.
3. **Root `@types/node` appears removable.** Removing it from the root manifest still lets `tsc --noEmit` pass, saving about **2.5 MB** and a little lockfile noise.
4. **The largest size is structural, not stale.** Pi SDK / provider support brings large provider clients and native/TUI optional deps. Reducing that meaningfully requires upstream/package-shape changes or a deliberate feature-gating strategy, not simple lockfile pruning.

## Direct package roots

`bun.lock` currently has **445 package entries** and a full install creates **408** physical `.bun` package directories under `node_modules/.bun`.

Workspace direct roots:

| Package | Declared in | Current classification | Codebase verdict |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` | root + `apps/pi-mom` | root dev, app prod | Required |
| `@slack/bolt` | `apps/pi-mom` | prod | Required |
| `@slack/web-api` | `apps/pi-mom` | prod | Required |
| `pi-mcp-adapter` | `apps/pi-mom` | prod | Required by current MCP proxy integration |
| `pi-subagents` | `apps/pi-mom` | prod | Required by current default-on subagent workflow |
| `pi-web-access` | `apps/pi-mom` | prod | Required by current default-on web access workflow |
| `typebox` | root | **dev** | **Required at runtime by app-loaded extensions; should move to dependencies** |
| `typescript` | root | dev | Required for `typecheck` only |
| `@types/node` | root | dev | Looks removable |

## Evidence from code references

### `typebox` is runtime-loaded

Root manifest currently declares `typebox` only as a dev dependency:

- `package.json:27-30`

But app-loaded extension factories import it:

- `extensions/linear-tools.ts:31`
- `extensions/browser-use-tools.ts:2`
- `extensions/slack-interactive-tools.ts:30`

Those extension factories are imported into the Pi runner:

- `apps/pi-mom/lib/pi-sdk-runner.mjs:88`
- `apps/pi-mom/lib/pi-sdk-runner.mjs:96-98`

Result: a production-only install lacks `typebox`, and `apps/pi-mom` tests fail immediately when an extension imports it.

### Slack packages are real usage, not stale lockfile weight

- `apps/pi-mom/index.mjs:1` imports `App`, `Assistant`, `LogLevel` from `@slack/bolt`.
- `apps/pi-mom/index.mjs:2` imports `WebClient` from `@slack/web-api`.
- `apps/pi-mom/doctor.mjs:2` also imports `WebClient`.
- `apps/pi-mom/lib/slack-sink.mjs` and `apps/pi-mom/lib/canvas-sink.mjs` rely on newer Web API surfaces.

Even though Bolt depends on Web API transitively, the direct `@slack/web-api` dependency is justified because app code imports it directly and relies on specific surfaces.

### Pi SDK and add-on packages are real usage

- `apps/pi-mom/lib/pi-sdk-runner.mjs:104-111` imports Pi SDK primitives from `@earendil-works/pi-coding-agent`.
- `apps/pi-mom/lib/pi-sdk-runner.mjs:144` resolves `pi-web-access/package.json`.
- `apps/pi-mom/lib/pi-sdk-runner.mjs:155` imports `pi-subagents/src/extension/index.ts`.
- `apps/pi-mom/lib/pi-sdk-runner.mjs:167` imports `pi-mcp-adapter`.
- `apps/pi-mom/doctor.mjs:64-85`, `201-216`, and `243-258` explicitly validate these packages.

These are not removable without changing current feature promises.

## Install-size measurements

Measured from a clean archive of the audited base.

| Scenario | Result | Notes |
|---|---:|---|
| `bun install --frozen-lockfile` | `281M` | Current full local/CI install; tests pass |
| `bun install --frozen-lockfile --production` | `255M` | **Broken today** because `typebox` is dev-only |
| Move `typebox` to `dependencies`, then `bun install --production` | `255M` | App test suite passes |
| Move `typebox` to `dependencies`, then `bun install --production --omit optional` | `222M` | App test suite passes |
| Remove root `@types/node`, then `bun run typecheck` | exit `0` | Suggests root `@types/node` is removable |

Current production failure evidence:

```text
$ cd apps/pi-mom && bun run check
error: Cannot find package 'typebox' from '/tmp/covent-current-prod/extensions/linear-tools.ts'
Bun v1.3.11 (Linux arm64)
error: script "check" exited with code 1
```

Validation after simulated `typebox` fix + `--omit optional`:

```text
$ cd apps/pi-mom && bun run check
linear-tools tests passed
slack-interactive-tools tests passed
pi-sdk-runner tests passed
skill discovery tests passed
route-config tests passed
failure-summary tests passed
slack-format tests passed
integration-health tests passed
subagent project agent tests passed
dispatch tests passed
thread-session-map tests passed
pi-session tests passed
slack-sink tests passed
slack-ui-context tests passed
home-view tests passed
canvas-sink tests passed
subagent-canvas-sidecar-sink tests passed
composite-sink tests passed
bun-compat smoke test passed — Stage 1 unblocked.
✓ persistence-check: all cases pass
```

## Largest installed packages

Top physical package directories in the full install:

| Package | Size | Primary reason it exists |
|---|---:|---|
| `koffi@2.16.2` | `27.8 MB` | Optional Pi TUI/native path |
| `typescript@5.9.3` | `22.9 MB` | Root typecheck |
| `@mistralai/mistralai@2.2.1` | `20.4 MB` | Pi AI provider client |
| `@google/genai@1.52.0` | `13.8 MB` | Pi AI provider client |
| `openai@6.26.0` | `13.3 MB` | Pi AI provider client |
| `@earendil-works/pi-coding-agent@0.74.0` | `12.5 MB` | Embedded Pi SDK |
| `web-streams-polyfill@3.3.3` | `8.8 MB` | Transitive provider/client support |
| `@mixmark-io/domino@2.2.0` | `8.7 MB` | `pi-web-access` HTML/readability stack |
| `@slack/web-api@7.15.2` | `7.8 MB` | Slack client |
| `pi-web-access@0.10.7` | `6.6 MB` | Default-on web/code/content tools |
| `@anthropic-ai/sdk@0.91.1` | `6.6 MB` | Pi AI provider client |
| `zod@4.4.3` | `6.4 MB` | Provider/schema ecosystem |
| `typebox@1.1.38` | `6.1 MB` | Pi SDK + repo extension schemas |
| `@modelcontextprotocol/sdk@1.29.0` | `6.0 MB` | `pi-mcp-adapter` |
| `@earendil-works/pi-ai@0.74.0` | `4.5 MB` | Pi AI layer |
| `@smithy/core@3.24.1` | `4.3 MB` | AWS/Bedrock provider support |
| `hono@4.12.18` | `3.6 MB` | MCP adapter stack |
| `protobufjs@7.5.7` | `3.1 MB` | Google/provider support |
| `axios@1.16.0` | `2.9 MB` | Slack SDK HTTP dependency |
| `linkedom@0.16.11` | `2.7 MB` | `pi-web-access` DOM parsing |
| `@types/node@22.19.19` | `2.5 MB` | Root dev dependency |
| `ajv@8.20.0` | `2.5 MB` | MCP adapter stack |
| `unpdf@1.6.2` | `2.3 MB` | `pi-web-access` PDF extraction |
| `@mariozechner/clipboard-linux-arm64-*` | `~4.4 MB total` | Optional clipboard/native path |
| `@silvia-odwyer/photon-node@0.3.4` | `2.2 MB` | Pi SDK image support |
| `pi-mcp-adapter@2.6.1` | `1.9 MB` | MCP proxy extension |

## Cluster-level interpretation

Approximate cluster sizes from installed package dirs:

| Cluster | Package count sampled | Approx installed size | Verdict |
|---|---:|---:|---|
| Pi SDK / Pi AI / TUI family | 4 | `19.0 MB` | Required, but includes headless-worker-irrelevant TUI/native surface |
| Pi AI provider clients | 5 | `55.3 MB` | Structural SDK weight; not repo-stale |
| AWS/Smithy/crypto support | 81 | `18.6 MB` | Bedrock/provider support from Pi AI stack |
| Slack/Bolt/Web API family | 15 | `13.5 MB` | Required and reasonable |
| `pi-web-access` HTML/PDF extraction | 16 | `22.9 MB` | Required only if default-on web/PDF tools remain strategic |
| MCP adapter stack | 10 | `16.2 MB` | Required by current MCP proxy integration |

Important caveat: closure graphs overlap heavily, so per-root transitive closure sizes should not be summed. The full physical install size is the reliable top-line number.

## What `--omit optional` removes

After moving `typebox` to production dependencies, `bun install --production --omit optional` removes these package dirs compared with production install:

```text
@mariozechner+clipboard-linux-arm64-gnu@0.3.2
@mariozechner+clipboard-linux-arm64-musl@0.3.2
@mariozechner+clipboard@0.3.5
@types+yauzl@2.10.3
koffi@2.16.2
source-map@0.6.1
```

This is the cleanest immediate deploy-size win because the Slack worker is headless and app tests pass without those optional packages.

## Depcheck evidence

`bunx depcheck --json .` result summary:

- root unused dev dependency: `@types/node`
- root used deps/devDeps: `typescript`, `@earendil-works/pi-coding-agent`, `typebox`
- no missing root deps

`bunx depcheck --json apps/pi-mom` result summary:

- no unused app dependencies
- no missing app dependencies
- app package usage keys: `@earendil-works/pi-coding-agent`, `@slack/bolt`, `@slack/web-api`, `pi-mcp-adapter`, `pi-subagents`, `pi-web-access`

## Recommendations

### Immediate PR-sized cleanup

1. Move `typebox` from root `devDependencies` to root `dependencies`.
2. Change production/Railway install to:

```bash
bun install --frozen-lockfile --production --omit optional
```

3. Keep CI/full local validation on full install:

```bash
bun install --frozen-lockfile
bun run check
```

4. Consider removing root `@types/node` after a dedicated tiny PR, since `tsc --noEmit` passed without it.

### Medium-term architecture options

1. If web access is not needed on most Slack turns, make `pi-web-access` route/feature gated instead of default-on. Potential gross size area: about `23 MB`, but only worth it if product behavior allows fewer web tools.
2. If MCP tools are not always needed, make `pi-mcp-adapter` opt-in by environment/config. Potential gross size area: about `16 MB`, but it is currently real product surface.
3. Ask/patch Pi SDK for a headless/core package split or optional provider clients. This is the only path that meaningfully reduces the `@mistralai`, `@google/genai`, `openai`, `@anthropic-ai/sdk`, AWS/Smithy, `koffi`, and TUI/native footprint without deleting Pi runtime capability.

## Proposed implementation sequence

1. **PR 1: dependency classification + deploy install shrink**
   - Move `typebox` to `dependencies`.
   - Update Nixpacks/Railway production install command to include `--production --omit optional` if deploy does not need root dev tools.
   - Validate with full `bun run check` and simulated production app check.

2. **PR 2: remove unused `@types/node`**
   - Remove root `@types/node`.
   - Regenerate `bun.lock`.
   - Validate `bun run typecheck` and `bun run check`.

3. **PR 3: feature-gating decision**
   - Decide whether `pi-web-access` and `pi-mcp-adapter` should remain default-on in the Slack worker.
   - If not, move their loading behind explicit config and validate route behavior.

## Commands run during audit

```bash
git fetch origin main --prune
git worktree add -b docs/bun-lock-waste-audit /home/jfloyd/worktrees/covent-agent-os-bun-lock-waste origin/main
bun install --frozen-lockfile
bun run check
bunx depcheck --json .
bunx depcheck --json apps/pi-mom
# plus throwaway archive installs under /tmp to test production, production+typebox, production+typebox+omit optional, and no-@types/node scenarios
```

## Final verdict

The lockfile waste is mostly **package-shape/platform-surface waste**, not unreferenced repo rot. The one clear repo bug is `typebox` living in `devDependencies` despite being runtime-loaded. The one clear deploy-size win is production install with `--omit optional` after that fix.
