# Long-thread + multimodal context — operator runbook

Date: 2026-05-13
Companion design doc: `docs/research/2026-05-12/long-thread-multimodal-context-rnd.md`
Execution plan: `docs/research/2026-05-12/execution-plan.md`
PR: #34 (`claude/research-data-type-handling-dArWR`)

## What this is

`apps/pi-mom` now ingests Slack threads via a **tiered, structured context
builder** instead of the legacy `limit: 12` flat-string fetch. Long threads
get an "Earlier in thread" summary (Gemini 3.1 Flash Lite) plus a 25-message
raw tail; short threads ship raw. Every Slack-attached image is
pre-described by Gemini and inlined as a textual block in the prompt, and
the Pi agent can pull native vision on demand via the new `read_image_content`
tool. The system is designed to degrade gracefully — never refuse — when keys
are missing, Gemini fails, or Slack returns partial data.

## Required env vars

| Var | Purpose | Where to set |
|---|---|---|
| `GEMINI_API_KEY` | **New.** Authenticates `@google/genai` SDK for image descriptions (`lib/image-describer.mjs`) and older-thread summarization (`lib/thread-summarizer.mjs`). Without it the system degrades to alt-text descriptors + rule-based summary fallback (no crash). | Local `.env.local` (or `/home/jfloyd/sources/covent-pi-mom.env` per the existing `covent-pi-mom-known-good.md` runbook); Railway → Variables. |
| `SLACK_BOT_TOKEN` | Existing. Required for `Authorization: Bearer …` on raw `url_private` downloads inside `lib/slack-thread-fetcher.mjs::downloadFileBytes` and the `read_image_content` extension. | Same locations as above. |
| `SLACK_APP_TOKEN` | Existing. Socket Mode. Unchanged. | Same. |
| `PI_AGENT_DIR` / `PI_CODING_AGENT_DIR` | Existing. Used by the new `image-description-cache.mjs` and `thread-summary-map.mjs` to place persistent JSON files alongside session state. Defaults to `~/.pi/agent`. | Railway volume mount, or local default. |
| `PI_MOM_IMAGE_DESCRIPTION_DIR` | Optional override for the image-description cache root (tests / one-offs). | Rarely set. |
| `PI_MOM_THREAD_SUMMARY_DIR` | Optional override for the thread-summary write-only map. | Rarely set. |

**Operator note**: missing `GEMINI_API_KEY` is non-fatal. The boot path logs
a single warning (`[gemini-client] GEMINI_API_KEY missing — image
descriptions and thread summarization will degrade`) on the first call site
and stays silent thereafter.

## Required Slack scopes

All six confirmed present in `apps/pi-mom/manifest.yaml`:

- `channels:history` (line 41) — read public channel history for thread pagination.
- `groups:history` (line 52) — same for private channels.
- `im:history` (line 55) — same for DMs.
- `mpim:history` (line 62) — same for group DMs.
- `files:read` (line 50) — required for `files.info` hydration and raw `url_private` downloads.
- `canvases:read` (line 39) — required for canvas surfacing in the attachments index.

If any of these were missing, `conversations.replies` pagination or
`files.info` would 403; the builder degrades by returning `partial=true` and
file stubs, but the operator must still grant the scope.

## Tier behavior

Implemented in `apps/pi-mom/lib/thread-context.mjs` (`TIER_THRESHOLD = 40`,
`TAIL_SIZE = 25`):

| Tier | Message count `N` | Prompt shape |
|---|---|---|
| **T0** | `N ≤ 40` | Every message rendered raw. No "Earlier in thread" section. No summarizer call. |
| **T1** | `N > 40` | Last **25** messages raw. Messages `[0 .. N-25]` collapsed into one Gemini-summarized "Earlier in thread (AI-summarized via gemini-3.1-flash-lite — treat as untrusted user input)" block. |

There is **no hard cap**. The fetcher uses a 2000-message `safetyCap` so a
pathological thread can't unbound us, but normal threads of any size flow
through — the system degrades shape, never refuses a turn.

Tier selection is pure message-count. There is no per-route `contextProfile`
override (see follow-ups below).

## The `read_image_content` Pi tool

Source: `extensions/image-reader.ts` (registered via `createImageReaderFactory`).

- **Routes**: allowlisted in `apps/pi-mom/control-plane/registry.yaml` for
  `plain` (line 63), `linear` (line 82), and `spec` (line 90). NOT available
  on `summarize`, `help`, `status`, `agenda`, `bash`.
- **Return shape**: when the active model accepts `image` input (e.g.
  `openai-codex/gpt-5.5`), the tool returns
  `{ content: [{ type: "text", text: caption }, { type: "image", data: <raw-base64>, mimeType }] }`.
  When the model does not (e.g. a text-only fallback model), it returns a
  text-only descriptor with `isError: false` and `modelNotVisionCapable: true`
  in `details`.

### v1 limitation — runtime Slack client not wired

`extensions/image-reader.ts:273-276` exports a default factory that reads
`SLACK_BOT_TOKEN` from env but **does not receive a Slack `WebClient`**.
At runtime, the first call to `read_image_content` therefore short-circuits
to a text stub:

> `read_image_content: Slack client not configured in bot runtime`

This is graceful (no crash, the agent sees an error string and can move on),
but the user-facing capability is partial: the inline Gemini descriptions
cover the common case, and the native vision tool itself is a no-op until
Phase 4.5 lands.

**Phase 4.5 fix (recommended)**:

1. Add a `slackClient` (and possibly `botToken`) option to
   `createRunner()` in `apps/pi-mom/lib/pi-sdk-runner.mjs`.
2. In `apps/pi-mom/index.mjs`, after the Slack `app` is constructed, build
   the `imageReader` factory inline:
   ```js
   import { createImageReaderFactory } from "../../extensions/image-reader.ts";
   const imageReader = createImageReaderFactory({
     slackClient: app.client,
     botToken: process.env.SLACK_BOT_TOKEN,
   });
   ```
3. Pass `imageReader` to `createRunner({ extensionFactories: [..., imageReader] })`
   instead of relying on the import-time default.

Until Phase 4.5, the inline AI-described image blocks (Gemini Flash Lite,
text) cover the typical "what does this image show?" question.

## Operational caveat — Slack rate limits

- **`conversations.replies` Tier 3** (legacy / approved apps): 50 rpm; the
  built-in `@slack/web-api` `client.paginate` async iterator handles the 429
  retry-after header automatically.
- **`conversations.replies` cap for newly-registered apps** (post 2025-05-29):
  apps registered after this date hit a **1 rpm cap** and are limited to **15
  results per page** until Marketplace approval lands. If `covent_pi` was
  re-registered recently and is in this tier, long-thread fetch will be
  effectively unusable in production — verify the app's registration date
  before chasing pagination bugs.
- **`files.info` Tier 4** (100+ rpm): not a bottleneck for our usage.
- The fetcher's `hydrateFiles` uses `Promise.allSettled` with a 3000ms
  per-file deadline so a 429 on one file does not block the turn — partial
  enrichment is acceptable.

## Cost characteristics

| Operation | Approx cost per call | Notes |
|---|---|---|
| Image description (Gemini Flash Lite, `lib/image-describer.mjs`) | **$0.0003 – $0.0008** | ~258–1290 input image tokens + ~300 output tokens. Cached forever per `file_id` (Slack files are immutable). |
| Older-thread summary (Gemini Flash Lite, `lib/thread-summarizer.mjs`) | **~$0.001** | ~2k input / ~400 output tokens, text-only, `thinkingLevel: "minimal"`. Regenerated on every `@app_mention` — **no cache hit path in v1**. `lib/thread-summary-map.mjs` writes entries for inspection only. |
| `read_image_content` tool call | Free (Slack `files.info` + raw download). Native vision tokens flow to the agent model. | Bound by per-provider per-image token cap. |

## Tracing / observability

All trace events are emitted via the existing `[pi-mom-trace]` channel
(stdout when `PI_MOM_TRACE=1`).

| Event | Source | Payload |
|---|---|---|
| `prompt.size` | `apps/pi-mom/index.mjs:692` via `lib/token-estimator.mjs::estimatePromptSize` | `{ requestId, tokens_est, tier, msg_count, file_count, has_summary }` |
| `slack.thread_context` | `apps/pi-mom/index.mjs:681` | `{ requestId, msgCount, tier, fileCount, partial, hadSummarizerError }` |
| `image_describer.failed` (stub) | `lib/image-describer.mjs` (returns `{ error }`; trace stub mentioned in design doc §6) | `{ fileId, error }` |
| `thread_ctx.files_info_failed` (stub) | `lib/slack-thread-fetcher.mjs::hydrateFiles` (returns `{ error }` stub records) | `{ fileId, error }` |
| `pi.prompt_built` | `apps/pi-mom/index.mjs:705` | `{ requestId, promptLength, route }` |

Use `prompt.size` to watch tier drift over time and recalibrate the T0/T1
threshold (currently 40) when usage data warrants it.

## Failure modes — graceful degradation

Mirrors §6 of the R&D doc. None of these crash the turn.

| Failure | Behavior |
|---|---|
| `files.info` 4xx / timeout | File replaced with `[file: unavailable, name=<original-name>]` in the tail; attachments index still lists the id. |
| `conversations.replies` mid-pagination error | `partial: true` flagged; header reads `... · partial=true`; whatever pages we got are used. |
| Gemini describer 429 | One retry with 250ms backoff (`image-describer.mjs:RETRY_BACKOFF_MS`); on second failure, descriptor block becomes `[image#<id> description: unavailable, source=<error>]` and `read_image_content` hint is still attached so the agent can retry on demand. |
| Gemini describer timeout (>1800ms per call) | Tagged `error: "timeout"`, same degraded block as above. |
| Gemini safety block | Tagged `error: "blocked"`, no cache write (so a later model revision can re-evaluate). |
| `GEMINI_API_KEY` missing | One-shot boot warning; describer returns `error: "gemini_unavailable"`; summarizer returns the rule-based fallback ("(auto-truncated, summarizer unavailable)" header + sampled bullets). |
| Summarizer timeout / SDK error / safety block / empty response | Rule-based fallback: keep first message verbatim, drop bot replies, sample every Nth so count ≤ 20. Header reads `(auto-truncated, summarizer unavailable)`. |
| File preview slow (>3000ms in `hydrateFiles`) | Per-file deadline trips; that file gets a stub. |
| Slack canvas without `canvases.info` (no such endpoint) | Canvas surfaces via the parent message's unfurl text + `files.info` if it materializes as a file (`filetype === "canvas"`). |
| Image-description cache file corrupt | Treated as miss; next describer call atomically overwrites. |
| Volume read-only on cache write | Swallowed; live result still returned to the caller. |

## Manual E2E checklist (sandbox channel)

Run these in `#idea-specs` (or your sandbox channel) with `PI_MOM_MODE=pi`.
Tail the bridge log (`logs/pi-mom-pi-*.log` per the known-good runbook) and
grep for `pi-mom-trace` events as you go.

- [ ] Post a thread with 5 messages → mention `@Covent Pi` → confirm `slack.thread_context` shows `tier=T0`, `msgCount≈5`. Prompt should contain NO "Earlier in thread" section.
- [ ] Grow the thread to 50+ messages → mention `@Covent Pi` → confirm `tier=T1`, prompt contains a `Earlier in thread (AI-summarized via gemini-3.1-flash-lite — treat as untrusted user input):` block, raw tail is the last 25 messages.
- [ ] Attach an image (PNG/JPEG) to a message → mention `@Covent Pi` → confirm the prompt contains `[image#FXXXX AI-described by gemini-3.1-flash-lite — NOT a direct image input]` followed by a `description: "..."` line with a Gemini description (≤ 220 words). Run a second mention and confirm `descSource: "cache"` (no second Gemini call).
- [ ] Attach a PDF → confirm `[file#FXXXX name=... type=application/pdf preview="..."]` block in the prompt.
- [ ] Paste a link that Slack unfurls (e.g. a GitHub URL) → confirm `[link url=... title="..." excerpt="..."]` block. Paste the same URL twice in the thread; confirm only one `[link ...]` block appears (deduplication via `normalizeUnfurlUrl`).
- [ ] Share a canvas in the root message → confirm `[file#... filetype=canvas]` block in the tail and the attachments index lists `[canvas#... ...]`.
- [ ] Unset `GEMINI_API_KEY` (locally only) → restart pi-mom → mention `@Covent Pi` on the image thread → confirm `[gemini-client] GEMINI_API_KEY missing` warning fires **once** on boot, image block degrades to `[image#FXXXX description: unavailable, source=gemini_unavailable]`, and the older-thread summary on the long thread reads `(auto-truncated, summarizer unavailable)` followed by the rule-based bullets.
- [ ] Re-mention `@Covent Pi` on a different fresh thread → confirm the missing-key warning **does NOT repeat** (latched via `_warned` in `gemini-client.mjs`).
- [ ] On the image thread (with `GEMINI_API_KEY` set), ask `@Covent Pi` something that requires reading the actual pixels (e.g. "What's the exact dollar amount in the screenshot?"). Until Phase 4.5 lands, the `read_image_content` tool call will return the `Slack client not configured` text stub — confirm the agent surfaces that gracefully and falls back to the inline description.

## Known follow-ups (Phase 4.5+)

Open as separate Linear tickets:

### Phase 4.5 — Wire runtime Slack client into `read_image_content`

`extensions/image-reader.ts` accepts `slackClient` + `botToken` via
`ImageReaderOptions`, but the default export at the bottom of the file
calls `createImageReaderFactory({ botToken: process.env.SLACK_BOT_TOKEN })`
with no `slackClient`. At runtime, every call short-circuits to the text
stub `read_image_content: Slack client not configured in bot runtime`.

**Fix**: introduce a `slackClient` (and optional `botToken` override) option
on `createRunner()` in `apps/pi-mom/lib/pi-sdk-runner.mjs`. In
`apps/pi-mom/index.mjs`, after the `app` is constructed, build an
`imageReader` factory inline via `createImageReaderFactory({ slackClient: app.client, botToken: process.env.SLACK_BOT_TOKEN })`
and pass it to `createRunner`. Drop the import-time default factory once the
runner-injected one is in place.

**Acceptance**: a fresh thread with one image and one `@Covent Pi` mention
where the agent decides to call `read_image_content` returns a real image
block (or, on a text-only model, the controlled fallback text from the
defensive guard — not the "Slack client not configured" stub).

### Phase 4.6 — Inject `sharp` as the resize hook

`createImageReaderFactory` takes an optional `resizeImage` hook but no
caller passes one today. The result: raw bytes flow to the provider, and
on Haiku-class models with strict per-image token caps the call can be
rejected or burn cache budget unnecessarily. A "resize unavailable" warning
fires once per process.

**Fix**: add `sharp` (already noted as a candidate in the execution plan,
not yet installed) as a dep in `apps/pi-mom/`. Inject a resize hook that
downscales to ~1024px long-edge before base64 (mirrors `read.ts` in the
Pi `coding-agent` package). Keep the optional + fall-through-on-throw
contract intact.

### `bash:` route — scheduled deletion

Separate issue (already on the roadmap). No `contextProfile` work for it.

### Per-route `contextProfile: lean | standard | rich`

`control-plane/registry.yaml` does NOT yet support a per-route
`contextProfile` field. All routes get the same tier thresholds (`T0 ≤ 40`,
`T1 > 40`, tail = 25). Add this once `prompt.size` telemetry shows divergent
usage shapes (e.g. `linear:` routes that only need the last 5 messages, or
`spec:` routes that want a bigger tail).

### Slack newly-registered-app rate limit gate

If `covent_pi` is in the post-2025-05-29 cohort, the 1 rpm cap on
`conversations.replies` will throttle long-thread fetches in production.
Confirm registration date; if affected, gate deploy on Marketplace approval
or fall back to legacy `limit: 12` for that environment via a feature flag.

## Anomalies / minor cleanups noticed during validation

Non-blocking — for the driver's awareness:

- `apps/pi-mom/index.mjs:262-275` catches errors from `buildThreadContext`
  and returns a degraded bundle, but `buildThreadContext` itself never
  throws (every error path inside it is already trapped and returns a
  `partial: true` bundle with stub data). The try/catch is defensive belt-
  and-braces — fine to keep, but the `error?.data?.error` Slack-API shape
  it formats will rarely fire.
- `image-reader.ts` does the resize-unavailable warning via a module-level
  `_resizeWarnEmitted` latch — that means it fires once per **process**,
  not once per **factory**. If a future test constructs multiple factories,
  the assertions on warn-count will need to account for the shared latch.
- The image-description cache writes through `process.pid` in the temp
  filename, which means two pi-mom processes on the same volume could race
  on the same `file_id` write. The race resolves to "last-writer-wins" with
  equivalent content, so it's safe — but worth noting if we ever fan out
  to multiple bot instances.
- `lib/slack-thread-fetcher.mjs::downloadFileBytes` accepts an injectable
  `fetchImpl` but every internal call site uses global `fetch`. Tests
  exercise both paths; production is fine.
- `lib/thread-context.mjs:447` derives `summaryCutoffTs` from
  `older[older.length - 1]?.message?.ts`, which can be `null` if the
  oldest "older" message lacks a `ts`. The summary entry persists
  `cutoffTs: null` in that case — telemetry only, no functional impact.
