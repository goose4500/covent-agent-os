---
name: prd-to-shipped
description: Take a PRD all the way from intake to shipped code through a disciplined R&D → plan → verify → implement → smoke cycle, leveraging parallel Explore subagents for codebase research and a Plan subagent for design, locking decisions with the user via AskUserQuestion before writing the final plan, then implementing in parallel where independent and verifying with offline mocked-fetch smoke tests rather than only type-checks. Use this skill whenever the user shares a PRD, spec, design brief, or feature description and asks to "implement", "build", "scope", "do R&D on", "figure out how we could implement", or "ship" it — even if they don't explicitly say "PRD".
---

# PRD to Shipped

A repeatable lifecycle for turning a PRD into shipped code together with the user. Optimized for **objective truth** (verified file paths, real verification) and **maximum efficiency** (parallel agents and parallel tool calls wherever they don't depend on each other).

## When this applies

The user has pasted a PRD or feature spec, or described a feature in enough detail to act as one, and wants you to scope, plan, and/or implement it. Enter at whichever phase fits — if they already have an approved plan and say "implement", jump to Phase 5.

## Core principles (the reason the workflow is shaped the way it is)

- **Subagents describe what they intended to do, not necessarily what they did.** After a research subagent returns, read its highest-cited files yourself before designing on top of them. Trust but verify.
- **Lock branching decisions with the user before writing the final plan, not after.** Plans built around unresolved forks get rewritten.
- **Parallelize what's independent, serialize what's ordered.** Multiple Explore agents, multiple file writes, multiple `node --check`s — same message. Anything that depends on a prior result waits.
- **Real verification, not formal verification.** Parse-checking and type-checking don't catch prompt-injection vectors, regex edge cases, retry-on-wrong-status bugs, or dedupe maps that never expire. A short offline smoke with mocked network and mocked LLM does.
- **Reuse before invent.** The codebase already has helpers. Find them, cite them by `file:line`, mirror existing patterns rather than parallel ones.

## Phase 1 — R&D (parallel research, then direct verification)

Goal: a mental model of the existing code accurate enough to design against.

1. Read the PRD end-to-end. Note its explicit "Open Questions" — those become AskUserQuestion items in Phase 3.
2. Orient: `ls` the repo root, read the README and the top of `package.json` (or equivalent) to learn the runtime, deploy target, and module layout.
3. Launch up to **3 Explore subagents in parallel, in a single message**. Split the work so they don't overlap:
   - one on the primary integration surface (the app, the route, the entry point)
   - one on related skills/utilities/extensions that might be reusable
   - one on architecture / security / boundary docs that gate the change
   Each prompt should be self-contained and ask for concrete file paths, line numbers, and short code excerpts — not paraphrased summaries.
4. When agents return, **read the highest-leverage files yourself** with the Read tool. Specifically: the entry point, the structurally-similar existing pattern you'll mirror (e.g., a sibling route handler), and any helper functions the plan will reuse. Confirm signatures and line numbers.
5. Synthesize: what exists, what's missing, what to reuse. This becomes the Context section of the plan.

## Phase 2 — Design (Plan subagent with verified context)

Goal: a concrete, opinionated implementation plan.

Launch a single Plan subagent. The prompt must include:

- **Verified facts** from Phase 1 — file paths, line numbers, function signatures
- **The PRD's hard requirements**
- **Open design choices** for the Plan agent to take a position on (modules layout, error handling, idempotency, env vars)
- **Hard constraints** (security/boundary rules, existing patterns to follow, "no new services / no new build systems / no new deps unless necessary")
- **Format requested**: files to create/modify with paths, module-level interfaces, manifest/env deltas, an end-to-end happy-path trace, failure modes table, verification plan, rollout commits

Read the plan critically. If it depends on a fact you didn't verify in Phase 1, verify it now before moving on.

## Phase 3 — Lock decisions with the user

Goal: surface every branching choice that materially affects the design, in one round-trip.

Use AskUserQuestion **once**, with up to 4 questions. Cover:

- The biggest architectural fork (e.g., new service vs. extend existing)
- The most consequential dependency choice (e.g., direct SDK vs. subprocess)
- Any PRD "Open Question" that changes scope
- The MVP boundary (what ships in v1 vs. deferred to Phase 2)

Mark your recommended option first with "(Recommended)". This is a forcing function: you state where you'd land if it were your call, the user endorses or redirects cheaply.

Do NOT use AskUserQuestion to ask "is the plan good?" — that's what ExitPlanMode is for.

## Phase 4 — Final plan + ExitPlanMode

Write the locked-in plan to the plan file with these sections:

- **Context** — why this change, what problem it addresses, what the user picked in Phase 3
- **Files to create/modify** — full paths, one paragraph each. For modified files, identify the exact insertion point (line range) and the shape of the change.
- **Reused from existing code** — function names + `file:line` citations
- **Manifest / scope deltas** (if any) — exact YAML/JSON lines
- **Env var additions** — table: name | purpose | example
- **End-to-end happy-path trace** — 8–12 numbered steps, naming the file/function at each step
- **Failure modes** — table: failure → behavior
- **Verification plan** — exact commands, expected output, the smoke-test approach
- **Phase-2 hooks** — clean seams left for follow-up work (no-op stubs, reserved env names)
- **Rollout order** — commit-by-commit plan, each step independently revertable, feature-flag default OFF, only the final step turns the feature on in production

Call ExitPlanMode.

## Phase 5 — Implement with maximum parallelism

1. **Read any remaining files** you need for exact line numbers / surrounding context.
2. **Write all independent new files in parallel** — same message, multiple Write tool calls. Pure modules, test harnesses, config files: no ordering dependency.
3. **Edit existing files** with Edit (one targeted change per call, so diffs review cleanly). Different files can be edited in parallel; same file goes sequentially.
4. **Feature flag default OFF.** The new handler/route early-returns until an explicit env var flips it on. The first deploy must be a no-op for production.
5. **Touch the existing entry point minimally.** Add imports + a new handler block; don't refactor neighboring code.
6. **Use TodoWrite** to track progress across the phase, especially when the implementation spans more than 3 distinct units.

## Phase 6 — Verify beyond `node --check`

`node --check` parses. The repo's typecheck only resolves declared types. Neither catches:

- A regex that eats the next URL after `<...|label>` in a Slack message
- A prompt that gets hijacked when a tweet contains the same closing fence
- A retry-once-on-5xx helper that silently retries on 4xx too
- A dedupe map that never expires

Run verification in this order:

1. **Component smoke** — a small script that exercises a pure-function module (URL classifier, parser, formatter) with adversarial inputs you've thought up. Fix anything it catches, re-run.
2. **Repo check suite** — whatever `npm run check` / `pytest` / `cargo test` resolves to. Note pre-existing failures: `git stash`, re-run on baseline, `git stash pop`. Only block on failures **your changes introduced**.
3. **Offline integration smoke** — write a temporary file in `/tmp` (do NOT commit) that:
   - Mocks the network (`global.fetch = async () => new Response(...)`)
   - Mocks the slow/expensive dependency (a fake `runPi`, a stubbed LLM client)
   - Exercises the full orchestrator end-to-end, including failure paths (4xx no-retry, 5xx retry-once-then-fail, `AbortController` timeout, empty response, missing metadata)
   - Tries adversarial inputs: prompt-injection attempts that close fences, fence collisions with the user-supplied content, very long inputs, three-of-each in one message
   - Asserts on observable behavior: returned values, mocked side-effect call counts, trace events
4. **Fix what the smoke caught, then re-run.** Every bug the smoke catches is a bug the user would otherwise hit in production with worse consequences.

Delete the `/tmp` smoke when you're done. Keep in-repo test harnesses if they were part of the plan.

## Phase 7 — Commit + push

- Stage **explicit paths**, not `git add .` or `-A` from the repo root (some repos' SECURITY.md is explicit about it).
- One commit per logical unit (skeleton + first commit; fix + second commit). Commit messages explain **why**, not what.
- Push to the branch named in the session's system prompt. Don't open a PR unless asked.

## Working with the user during the lifecycle

- Before your first tool call in each phase, state in one sentence what you're about to do.
- When a smoke test surfaces a real bug, say so plainly: "smoke caught a real quirk: X. Fixing." Don't hide it inside a paragraph of context.
- When you decide to deviate from the plan, say so before doing it.
- End-of-turn summary is one or two sentences. Don't re-explain the plan to the user — they wrote half of it.

## Anti-patterns this skill exists to prevent

- **Sequential research when parallel works.** Three Read calls in a row across unrelated dirs should have been three Explore agents in one message.
- **Plan written against unverified claims.** Agent says "the image route bypasses Pi" — you cite that in the plan without reading the image route. Read it.
- **Skipping AskUserQuestion to "save time".** Sixty seconds of clarifying forks saves an hour of rewriting plan + implementation.
- **`node --check` as "verification".** It's a syntax check. Call it that. Real verification exercises the code with adversarial inputs.
- **Committing the integration smoke.** It uses mocks; it only makes sense in the moment. `/tmp` and delete.
- **Deploying with the feature ON.** First deploy is OFF + clean rollback. Flip the flag separately after the deploy is healthy.

## Example: end-to-end shape of a session using this skill

```
User: <pastes a PRD for a Slack listener that pulls transcripts and posts AI analysis>

You:
  - Phase 1: read PRD; ls repo; launch 3 Explore agents in parallel (runtime, related skills, architecture docs); read entry point and the existing "bypass route" yourself.
  - Phase 2: launch Plan agent with verified line numbers + PRD constraints + hard rules.
  - Phase 3: AskUserQuestion (one round, 4 questions): extend existing service or new one? direct SDK or subprocess? top-level only or threads too? archive in v1 or Phase 2?
  - Phase 4: write final plan with Context, file list, reuse citations, manifest delta, env table, E2E trace, failure modes, verification plan, Phase-2 hooks, rollout order. ExitPlanMode.
  - Phase 5: parallel-write 7 new pure modules + 3 test harnesses; sequential edits to entry point / manifest / .env.example.
  - Phase 6: classifier smoke (caught regex bug, fix, re-run); full repo check (typecheck noise pre-existing on baseline, confirmed via stash); offline integration smoke with mocked fetch + mocked runPi (50 cases, caught prompt-injection fence collision, fix, re-run).
  - Phase 7: two clear commits (feature + fix), push to the session's branch.
```
