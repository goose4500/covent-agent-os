# ADR 0005 — Strategy stack formalization deferred (Path A)

Status: Accepted
Date: 2026-05-13
Decider: Jake Floyd

## Context

Between 2026-05-12 and 2026-05-13, Foundation v2 shipped (#24 merged) and produced the first end-to-end working production bot. In the 24 hours after the merge, two adjacent agent-authored proposals landed simultaneously on the repo:

- **Cluster A (simplification):** PR #44 — rip the safety scaffolding, validator scripts, and the control-plane registry layer. Replace registry.yaml + registry-loader.mjs + action-resolver.mjs with an inline ROUTES const and a 7-line local resolveAction() in apps/pi-mom/index.mjs.
- **Cluster B (architectural formalization):** Issues #40 (TypeBox registry validation), #41 (promote variation points from code to data), #42 (Action.run facade as the keystone), #46 (renderCall/renderResult across every tool), #49 (slack-api-guard.ts).

The two clusters are mutually incompatible. #44 deletes the exact substrate (registry.yaml + the safety-extension pattern) that #40/#41/#42/#46/#49 want to extend.

A 5-agent investigation produced opposite verdicts from the same evidence (`.claude/jobs/d7e75400/batch3-*.md`). path-architect voted Cluster B (4/5 criteria) with carve-ins from #44. value-anchor voted Cluster A — Foundation v2 just shipped, the next 30 days should exercise the runtime with outcomes, not formalize the abstraction underneath. safety-adversary cleanly diagnosed that 3 of 4 deleted safety extensions were dead code in pi-mom, and only `permission-gate.ts` was load-bearing.

## Decision

Take Cluster A. #44 merged at `3c1e37c` (post-rebase). The user's stated values — simplification, high leverage in terms of the foundation, idiomatic Bolt+Pi+Block Kit — combined with the user's explicit "security isn't a big concern as of right now" direction, point at this path.

Cluster B is deferred, not rejected. The analysis in #40/#41/#42/#46/#49 is technically excellent. The timing is wrong for the current scale.

## Trigger conditions for reopening

Reopen the Strategy formalization when any **two** of the following are simultaneously true:

1. **Routes ≥ 15.** Today: 9 (`plain`, `help`, `status`, `summarize`, `linear`, `agenda`, `spec`, `team`, `bash`). The route catalog in `apps/pi-mom/lib/routes.mjs` becomes uncomfortable to read or modify around 15 entries.
2. **Distinct sink kinds ≥ 5.** Today: 3 (`slack-sink`, `canvas-sink`, `subagent-canvas-sidecar-sink`). At 5+, the `composite-sink` config becomes a real configuration surface that benefits from a registry shape.
3. **Distinct extension factories/paths ≥ 8.** Today: app factories/paths cover Linear, Slack interactive tools, Browser Use, git checkpoint, `pi-subagents`, and `pi-web-access`. At 8+, hardcoding the default app surface in `pi-sdk-runner.mjs` becomes a friction point.
4. **A second non-Slack surface is actively in development (not just specced) that calls `runPi`.** Today: none. CLI / MCP / HTTP receivers are hypothetical. Once one is being built, the value of a typed Action/Run facade becomes concrete.

When two of these four are true, reopen #41 and #42 with current code references and execute. Re-evaluate #46 (per-tool renderers) at the same time. Reopen #40 only if a new registry-shaped config has been reintroduced.

## Consequences

**Accepted as a trade-off:**

- The `Action / Run / Approval / Artifact` vocabulary stays in `README.md` and `BOUNDARY.md`, not in code. Adding a new route is editing `ROUTES` in `index.mjs`, not a YAML edit.
- Adding a new policy gate to a single route requires editing `pi-sdk-runner.mjs:175` (which applies to every route) and gating inside the extension on `event.toolName` or route context. This is more friction than registry-driven `extensions:` arrays would be.
- All Pi-backed Slack routes now ship the full registered tool/skill/app-extension surface by default. Trust perimeter is `SLACK_ALLOWED_CHANNEL_ID` + Codex sign-in + explicit user intent. PR #47's audit identified this blast-radius trade-off; we explicitly accept it at the current scale.
- `extensions/env-guard.ts`, `linear-mcp-guard.ts`, `slack-mcp-guard.ts`, and `permission-gate.ts` are all gone. Restoring any of them requires fetching from git history and re-deriving the wiring.
- Secret/skill/agent validation remains covered by the current `bun run check` path; keep it green before merging.
- Pi-mom explicitly loads app-approved extension factories/paths in `pi-sdk-runner.mjs`; route-specific safety extensions are gone.

**Preserved in this round:**

- `extensions/linear-tools.ts` (TypeBox-typed Linear API tools) — wired into `extensionFactories`.
- `extensions/slack-interactive-tools.ts` (Block Kit cards introduced by #45) — wired into `extensionFactories`.
- Skills loading from `./skills` (introduced by #51) — still on; the model uses skill descriptions to pick the operating mode per turn.
- `lib/slack-sink.mjs`, `lib/canvas-sink.mjs`, `lib/composite-sink.mjs` — sinks are still factory closures, just hardcoded rather than registry-driven.
- `lib/pi-sdk-runner.mjs` — still the single integration point with the Pi SDK; receives `sink`/`uiContext` and activates all registered tools for normal Slack turns.

## What this means for the next 30 days

The bot's leverage move is more capability per merged PR, not more abstraction per merged PR. Concretely:

- #34 — long-thread + multimodal context handling (capability)
- #48 — event-driven Pi runs: webhook receiver → synthetic Slack message → existing runner (capability)
- #29 — interactive App Home cockpit polish (partially landed via #43/#45; remaining work is small)
- #27 / #28 — Pi harness and Slack surface cleanup (further simplification)
- #50 — github_api summarizeBody truncation polish

Issues kept open for tracking after this ADR:

- #27, #28, #30 — operational/cleanup follow-ups from PR #33's audit
- #31, #32 — decisions partially answered (plain-route status quo, dependabot held, packages/ already deleted)
- #38, #39, #50 — small typed-primitive backlog
- #46 — kept open per user choice (UX tracking, not blocking)
- #48 — Batch 4 capability candidate

## References

- Investigation reports: `.claude/jobs/d7e75400/batch3-{path-architect,value-anchor,safety-adversary,rebase-map,pr53}.md`
- Decision memo: `.claude/jobs/d7e75400/BATCH3-DECISION.md`
- Session synthesis: `.claude/jobs/d7e75400/SYNTHESIS.md`
- Closed issues: #40, #41, #49 (and #42 to be closed once this ADR merges)
- Closing PR for the architectural pivot: #44 (`3c1e37c`)
- Architecture audit that flagged plain-route safety: #47 (`f1f0f7c`)
