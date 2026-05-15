> [!WARNING]
> **Archived / superseded.** This document is historical evidence only. Do **not** use it as current agent instructions or implementation truth. Current truth starts at `README.md`, `docs/SYSTEM_INDEX.md`, `docs/AGENT_CONTEXT.md`, `docs/architecture.md`, and `apps/pi-mom/README.md`.

# PR #4 audit: insights auto-analyzer

## Recommendation

**Do not land PR #4 as-is. Decompose.** The pure URL/classifier/prompt/format work is close to a useful MVP slice, but the PR combines an always-on passive Slack channel listener, Apify third-party fetches, direct Pi subprocess execution, manifest event-surface expansion, manual smoke scripts, and an unrelated `prd-to-shipped` skill. That is too much to merge while the repo is actively adding the **Agent Run Card** route/state model and has a separate modularity/TypeScript route-registry refactor in flight.

Best path: land a smaller, feature-flagged and testable **insights core** now; land the Slack listener only after it is adapted to the route registry / Agent Run Card authority model.

## Smallest valuable slice

1. **Keep / land now as pure core, if extracted cleanly:**
   - `lib/insights/url-classifier.mjs`
   - `lib/insights/prompt.mjs` with the random transcript fence
   - `lib/insights/format.mjs`
   - `lib/insights/dedupe.mjs` after changing failure semantics
   - focused classifier/prompt tests wired into `npm run check` or `apps/pi-mom` check
2. **Defer or separate:**
   - Slack `message.channels` listener and manifest event subscription
   - Apify live client / actor defaults until actor payloads are validated
   - direct `runPi()` invocation from a passive listener
   - Notion/archive reserved env names
   - `skills/prd-to-shipped/SKILL.md` (unrelated PR)
3. **MVP behavior to ship first:** support a single explicit command/route, e.g. `@Covent Pi insights: <url>` or an Agent Run Card draft, in the already allowed channel. Then expand to passive `#insights` auto-analysis after privacy, cost, and concurrency controls are proven.

## Main risks / blockers

- **Authority-model mismatch:** `BOUNDARY.md` says every route should declare input shape, allowed context, tools, approval, output, failure, and redaction behavior. This PR adds an autonomous passive route that posts threaded analyses without explicit user command or Agent Run Card confirmation.
- **Agent Run Card conflict:** current branch has persistent run state, Start/Cancel confirmation, concurrency (`PI_MOM_AGENT_MAX_CONCURRENT`), bounded runners, and optional Canvas output. PR #4 bypasses all of that with untracked Apify + Pi work. Insights should either become a card-backed agent run or share the same runner/queue/state primitives.
- **Modularity conflict:** PR modifies the monolithic `apps/pi-mom/index.mjs`. The modularity branch (`origin/claude/refactor-app-modularity-FcmE5`) deletes `index.mjs`, introduces `index.ts`, route registry, adapters, config, domain modules, and route files. Landing PR #4 now will create structural rework even though `git merge-tree` shows no textual conflict with the Agent Run Card branch.
- **Slack event-surface expansion:** adding `message.channels` means the app starts receiving public-channel messages, not just mentions/DMs. Even flag-gated, this is a privacy/operational change and likely needs separate review/reinstall planning.
- **No shared concurrency/cost controls:** multiple #insights messages can spawn parallel Apify calls and Pi subprocesses; the Agent Run Card work intentionally limits agent concurrency.
- **Dedupe bug:** `analyzeUrl()` records the URL before fetch/analyze succeeds, so a transient Apify/Pi failure suppresses retries for the TTL.
- **Third-party/API hardening:** Apify token is placed in the query string; redaction does not include `apify_api_...`; actor input/output shapes are guessed and only covered by manual smoke harnesses.
- **Validation gap:** CI passed, but the new test harnesses are not part of the check suite. `node --check` will not catch actor-shape, retry, dedupe, prompt-injection, or Slack-message edge cases.
- **Unrelated scope:** `skills/prd-to-shipped/SKILL.md` is unrelated to insights and should be its own PR.

## Validation needed before Slack listener lands

- Unit tests in repo check for URL extraction, Slack-wrapped links, trailing punctuation, duplicates, unsupported URLs.
- Prompt test proving transcript fence collision/injection text stays inside the fence.
- Apify client tests with mocked `fetch`: 4xx no retry, 5xx retry once, timeout, non-array response, empty transcript, Spotify fallback.
- Dedupe tests: success suppresses duplicate; failed fetch/analyze does **not** suppress retry unless intentionally documented.
- Handler-level smoke with mocked Slack client, mocked Apify, mocked Pi: top-level-only, configured channel only, bot/subtype ignored, multiple links, no cross-channel response.
- Concurrency/cost test or design: max active insights jobs, queue/drop behavior, timeout visibility in Slack.
- Manual rollout checklist: Slack app reinstall for `message.channels`, feature flag off by default, dry-run in one private channel, then explicit enable.

## Files touched by PR #4

- `apps/pi-mom/.env.example`
- `apps/pi-mom/index.mjs`
- `apps/pi-mom/lib/insights/analyze.mjs`
- `apps/pi-mom/lib/insights/apify-client.mjs`
- `apps/pi-mom/lib/insights/config.mjs`
- `apps/pi-mom/lib/insights/dedupe.mjs`
- `apps/pi-mom/lib/insights/format.mjs`
- `apps/pi-mom/lib/insights/prompt.mjs`
- `apps/pi-mom/lib/insights/url-classifier.mjs`
- `apps/pi-mom/manifest.yaml`
- `apps/pi-mom/test-insights-analyze.mjs`
- `apps/pi-mom/test-insights-classifier.mjs`
- `apps/pi-mom/test-insights-fetch.mjs`
- `skills/prd-to-shipped/SKILL.md`
