# Hosted HTML previews: Pi-generated artifacts that render live in a browser, surfaced in Slack

**Type**: `ux` / `infra`
**Source**: 2026-05-15 research thread spun out of [issue #71](https://github.com/goose4500/covent-agent-os/issues/71) ("Code generation/File generation UX") after the file-artifact half shipped on `claude/research-slack-integration-mI2pZ` (commit `6c9d8ce`).
**Surface**: new `apps/pi-preview/` Railway service + new `slack_post_preview` Pi tool + new `postPreview()` method on `apps/pi-mom/lib/slack-ui-context.mjs`.
**Risk**: Medium-low. Adds a second Railway service (incremental cost, separate failure domain), but pi-mom itself only gains one Pi tool + one bridge method behind a no-op env-var guard.
**Expected diff**: ~340 LOC across two apps. Bot side ~205 LOC (mirrors the shipped `slack_post_artifact` pattern); preview service ~135 LOC (one `index.mjs` + Railway scaffolding + README).

## Context

After shipping `slack_post_artifact` (file upload into a Slack thread with a Card-block metadata tile), the obvious follow-up is: what if the artifact is an HTML page? Today the user gets a `.html` file they can download and open locally. They asked for the rendered, interactive page to appear directly inside Slack.

**Hard limit:** Slack does not render arbitrary HTML/JS/CSS in any surface it ships — not messages, not canvases, not Block Kit (the May-2026 Card / Alert / Carousel / Task Card / Plan / URL Source / Video blocks are all Slack-defined components, not HTML embeds). There is no iframe block, no HTML sandbox. The closest Slack does is OG-metadata unfurl of a posted URL. So "interactive HTML inside Slack" collapses to: **host the page somewhere with a public URL, post the URL into Slack, let Slack's link unfurl render a preview card, user clicks → opens in their browser**.

That's a separate feature from the file-artifact upload; this doc designs it.

## Why

The pattern is universally used by every other "AI generates a page" product as of May 2026 — Claude.ai's Artifact "share to Slack", v0.dev, bolt.new, Replit Agent. None of them embed live HTML in Slack; all post a URL. The team's pi-mom should match the bar.

Spinning this off as a separate feature (vs widening `slack_post_artifact`) is justified because:
- The hosting infrastructure is meaningful (new Railway service, shared secret, TTL/cleanup, OG-tag injection)
- The model's intent splits cleanly: *"download this file"* (slack_post_artifact) vs *"see this page running"* (slack_post_preview)
- It can ship behind a missing env var with zero impact on the existing artifact flow

## Constraints chosen at scoping time (2026-05-15)

- **Hosting target**: Railway only. No Cloudflare Pages / Vercel / Fly.io. Matches the team's existing infra and the `railway-debugger` operator agent.
- **Auth**: public URLs are acceptable. ~48 bits of slug entropy is the access control; leaked links leak the artifact. Acceptable because Pi-generated previews are intentionally throwaway.
- **Thumbnails / `og:image`**: explicitly deferred. v1 ships with text-only OG unfurl.
- **Multi-asset uploads** (CSS, images alongside the HTML): explicitly deferred. v1 ships one `index.html` per slug.
- **Pinned/forever previews**: explicitly deferred. v1 ships a 7-day TTL.

## Phase A research findings

Three parallel research agents ran on 2026-05-15. Reports kept in the session; key facts surfaced below.

### P1 — Railway architecture

Two Railway facts collapse the option space:

1. **Volumes cannot be shared between Railway services.** "Each service can only have a single volume." This kills the natural "bot writes HTML into a volume, static server serves it" pattern outright. Confirmed against [docs.railway.com/volumes/reference](https://docs.railway.com/volumes/reference).
2. **Storage Buckets are private-only.** "Public buckets are currently not supported." So even if we add object storage, we still need a public-facing proxy service in front of it. Confirmed at [docs.railway.com/storage-buckets](https://docs.railway.com/storage-buckets).

Service-to-service HTTP over `SERVICE_NAME.railway.internal` is Wireguard-encrypted and free of public bandwidth. Confirmed at [docs.railway.com/networking/private-networking](https://docs.railway.com/networking/private-networking).

| Option | Verdict |
|---|---|
| H1 shared-volume static server | **Blocked** — volume sharing not supported |
| H2 cross-mount volume | **Blocked** — same |
| **H3 bot POSTs to a separate preview service** | **Pick.** ~$5/mo extra, ~50 LOC server, ~30 LOC bot wiring, ~1 hour to first deploy |
| H4 add HTTP ingress to `covent-pi-mom` | **Reject.** Violates the "long-running Socket Mode worker, not HTTP" comment in `apps/pi-mom/railway.toml`; preview redeploys would bounce Slack |
| H5 Bucket + proxy service | **Reject.** Same LOC as H3, extra S3 dependency, presigned-URL ceremony |

### P2 — Pi-side tool + bridge design

Mirror the structure that shipped for `slack_post_artifact` (commit `6c9d8ce`):

- **New Pi tool `slack_post_preview`** in `extensions/slack-interactive-tools.ts`, registered alongside `slack_post_artifact`. Params: `{ filename, file_path, mime_type?, description? }`. Returns `deployed preview at <url>` with `details: { url }` on success.
- **New bridge method `postPreview(filename, filePath, mimeType, opts)`** on `apps/pi-mom/lib/slack-ui-context.mjs`. Reads the file, POSTs to the preview service over private networking with the shared secret, posts the returned public URL as plain text into the current Slack thread (relying on Slack's OG-tag unfurl for the card UX).
- **Tool vs flag**: separate tool, not a flag on `slack_post_artifact`. Tradeoff: more discoverable for the model, less risk of intent confusion.
- **Slack message shape (v1)**: inline plain text + URL. Let Slack's auto-unfurl do the visual work, fed by OG tags injected by the preview service (see P3). Card-block + Link-button variant deferred to v2.

### P3 — Slack link UX

The big finding: **with no OG tags on the served HTML, Slack shows the link as a bare clickable URL — no card at all**. Quote from Slack's link-unfurl guide: *"If nothing meeting the above criteria can be found, no unfurl will be shown."* That's the v0 baseline and it's ugly.

The cheapest fix by an order of magnitude is **inject 4 OG meta tags into the served HTML**:

```html
<meta property="og:title" content="Preview — {{slug}}">
<meta property="og:description" content="Generated preview · covent-pi">
<meta property="og:url" content="https://covent-pi-preview.up.railway.app/p/{{slug}}/">
<meta name="twitter:card" content="summary">
```

The clever architectural move from P1+P3: **the preview service injects these tags on the fly, wrapping the model's HTML body**. The model never has to remember Slack-unfurl conventions; it just writes a normal HTML document.

Tier ladder:

| Tier | What | LOC | Outcome |
|---|---|---|---|
| **T1 (v1)** | Preview service injects 4 OG tags into served HTML | ~15 (inside the preview service) | Slack auto-renders a summary card with title + description |
| **T2 (deferred)** | Register `app_unfurl_domains` + subscribe `link_shared` + Bolt handler calls `chat.unfurl` with section/context/actions blocks | ~50 (in `apps/pi-mom/index.mjs`) | We fully control the unfurl card. Slack `links:read`/`links:write` scopes already in `manifest.yaml:70-71`; missing only the `link_shared` event subscription and an `app_unfurl_domains` entry. |
| **T3 (deferred)** | Real screenshot for `og:image` → big-card unfurl | n/a | Biggest visual jump; needs the thumbnail subsystem we explicitly deferred |

Note that the **new 2026 `card` block is NOT documented as supported inside `chat.unfurl`** — only inside `chat.postMessage` and streaming. So even when we build T2, we should use `section + context + actions` blocks (matching the team's existing idiom in `slack-sink.stop()`), not Card. This contradicts a tempting "use the same Card we used for `slack_post_artifact`" intuition.

`url_source` is only valid inside `task_card` blocks, not at message top level. `video` block requires `links.embed:write` (not in our manifest) and iFrame-embeddable URLs. Neither is useful here.

## Locked v1 design

**Architecture (P1's H3)**: a new `covent-pi-preview` Railway service in the same project as `covent-pi-mom`. Bot uploads HTML over `http://covent-pi-preview.railway.internal:8080/upload` (private, secret-gated). Preview service stores files on its own 1 GB Volume mounted at `/data`. Public URL: `https://covent-pi-preview.up.railway.app/p/<8-char base64url slug>`. 7-day TTL with lazy check on read + 6-hour background sweep. `/healthz` endpoint for ops.

**Pi-side (P2's design)**: new `slack_post_preview` tool + `postPreview()` bridge method, structurally identical to the shipped `slack_post_artifact` / `postFile` pair.

**Link UX (P3's T1)**: preview service injects OG tags into the served HTML. v1 ships text + URL in the Slack thread; Slack auto-unfurls. T2 (custom `chat.unfurl`) only if T1 proves insufficient in practice.

## File-by-file diff

### New: `apps/pi-preview/`

| File | LOC | Purpose |
|---|---|---|
| `apps/pi-preview/index.mjs` | ~70 | Bun.serve HTTP server. `PUT /upload` (private, secret-gated); `GET /p/<slug>` (public, injects OG tags); `GET /healthz`. 7-day TTL with lazy + background-sweep cleanup. Zero npm deps. |
| `apps/pi-preview/railway.toml` | ~10 | Nixpacks + `bun index.mjs`, mirrors `apps/pi-mom/railway.toml` |
| `apps/pi-preview/nixpacks.toml` | ~2 | `nixPkgs = ["bun"]` |
| `apps/pi-preview/package.json` | ~12 | `bun >= 1.3.0` engine, `start` script |
| `apps/pi-preview/.env.example` | ~8 | `PREVIEW_SHARED_SECRET`, `PREVIEW_TTL_DAYS`, `PORT`, `PREVIEW_BASE_PUBLIC` placeholders |
| `apps/pi-preview/README.md` | ~30 | Runbook (env, `/healthz`, expiry policy, Railway service setup pointers) |

### Modified: `apps/pi-mom/`

| File | Δ LOC | Change |
|---|---|---|
| `extensions/slack-interactive-tools.ts` | +55 | New `slack_post_preview` tool registration; `SlackUI.postPreview?` typing on the type-erased view |
| `apps/pi-mom/lib/slack-ui-context.mjs` | +80 | New `postPreview(filename, filePath, mimeType, opts)` method exported on the returned object; mirrors `postFile`'s disposed/trace plumbing |
| `apps/pi-mom/lib/routes.mjs` | +4 | Rephrase `ARTIFACT_INSTRUCTION`: model picks `slack_post_artifact` for source file, `slack_post_preview` for live page, both for both |
| `apps/pi-mom/.env.example` | +2 | `PREVIEW_BASE_INTERNAL`, `PREVIEW_BASE_PUBLIC` placeholders (+ optional `PREVIEW_SHARED_SECRET`) |
| `apps/pi-mom/.env.railway.example` | +4 | Same vars with Railway-flavoured comments |
| `apps/pi-mom/test-slack-interactive-tools.mjs` | +25 | New tool: registration / success / error / signal-forward / non-Slack-bound cases |
| `apps/pi-mom/test-slack-ui-context.mjs` | +35 | New bridge method: POST shape / fail-soft / disposed / no-host-url-configured cases |
| `apps/pi-mom/package.json` | +1 | (none expected — existing test files cover the new cases) |

### Root

| File | Δ LOC | Change |
|---|---|---|
| `package.json` workspaces | +1 | Include `apps/pi-preview` so `bun install` picks it up |

**Total: ~340 LOC across two services.**

## What's NOT in v1 (deferred)

- **Custom Bolt `link_shared` + `chat.unfurl` handler** (P3 T2, ~50 LOC). Only build if the OG-tag unfurl proves insufficient.
- **Thumbnails / `og:image`** (P3 T3). Explicitly deferred at scoping time. When added, flip `twitter:card` to `summary_large_image` for a big-card unfurl.
- **Multi-asset uploads** (HTML + CSS + images). Single `index.html` per slug for v1. Adding this needs a `.zip` or `.tar` upload path and ~20 LOC of unpack logic.
- **Auth-gated preview URLs**. Public is acceptable per scoping.
- **Pinned/forever previews**. 7-day TTL is the default. Adding "never expire" would need a small sidecar JSON per upload.
- **Card-block + Link-button Slack message** (P2's "sub-option B"). v1 ships plain text + URL; revisit if the unfurl card feels bare.

## Operational setup (not code — Railway dashboard)

These cannot ship from the PR. They are one-time actions in the Railway dashboard:

1. In the `covent-pi-mom` Railway project, create a second service `covent-pi-preview`.
2. Attach a **1 GB Volume mounted at `/data`** to the new service (Hobby plan max is 5 GB).
3. Generate the public **`*.up.railway.app`** domain for `covent-pi-preview`.
4. Set the following variables on **`covent-pi-preview`**:
   - `PREVIEW_SHARED_SECRET=<random 32-byte hex>` — same value as the bot
   - `PREVIEW_TTL_DAYS=7` (or whatever; env-configurable)
   - `PREVIEW_BASE_PUBLIC=https://covent-pi-preview.up.railway.app`
   - `PORT=8080`
5. Set the following variables on **`covent-pi-mom`**:
   - `PREVIEW_BASE_INTERNAL=http://covent-pi-preview.railway.internal:8080`
   - `PREVIEW_BASE_PUBLIC=https://covent-pi-preview.up.railway.app`
   - `PREVIEW_SHARED_SECRET=<same value as above>`

**Cost**: ~$5/mo additional (one extra Hobby service + ~$0.25/GB-mo for the small volume).

**Failure mode if not set up**: `postPreview()` checks `PREVIEW_BASE_INTERNAL` at runtime; if missing, returns `{ ok: false, error: "PREVIEW_BASE_INTERNAL not configured" }` and the tool surfaces a clean error message. Nothing else in pi-mom is affected.

## Verification

1. `bun run check` clean (existing pi-mom tests + new `postPreview` / `slack_post_preview` cases).
2. Local: spin up the preview service with `cd apps/pi-preview && PREVIEW_SHARED_SECRET=test bun index.mjs`. `curl -X PUT http://localhost:8080/upload -H 'x-preview-secret: test' --data '<html><body>hi</body></html>'` returns `{ id, url }`. `curl http://localhost:8080/p/<id>` returns the HTML with OG tags injected.
3. Staging: deploy `covent-pi-preview` to Railway with `PREVIEW_BASE_PUBLIC` set; ping `https://covent-pi-preview.up.railway.app/healthz`.
4. End-to-end: `@Covent-Agent build me a single-page color-picker in HTML and give me the live link`. The Pi turn streams the source into the reply, then calls `slack_post_preview` with the `/tmp/` path; the bot posts the URL; Slack unfurls a summary card; clicking opens the running page in a browser.
5. TTL: post a preview, wait 7 days (or set `PREVIEW_TTL_DAYS=0.01` locally), confirm `GET /p/<id>` returns `410 Gone` and the directory is cleaned.

## Open questions before spike

1. **Multi-asset shape**. The "single `index.html` per slug" cap is tight. If the model can't inline CSS, the preview will look raw. Worth checking: do you want me to allow inline `<style>` only (zero-cost, model writes a self-contained file), or budget the +20 LOC for a `.zip` upload path now?
2. **Default TTL**. 7 days mirrors the "reversible / scratch" half of `BOUNDARY.md`. If you want longer (30d) or shorter (24h), say so; it's just an env var default.
3. **Should the preview service expose a `DELETE /p/<id>` endpoint** for explicit cleanup before TTL, gated by the same shared secret? ~5 extra LOC. Cheap insurance, but unnecessary for v1.

## Sources

### Railway
- [Volumes Reference | Railway Docs](https://docs.railway.com/volumes/reference) — single-volume-per-service constraint, Hobby max 5 GB
- [Storage Buckets | Railway Docs](https://docs.railway.com/storage-buckets) — "Public buckets are currently not supported"
- [Private Networking | Railway Docs](https://docs.railway.com/networking/private-networking) — `SERVICE_NAME.railway.internal`, Wireguard-encrypted, use `http://`
- [Working with Domains | Railway Docs](https://docs.railway.com/networking/domains/working-with-domains) — `*.up.railway.app` default
- [Pricing Plans | Railway Docs](https://docs.railway.com/pricing/plans) — Hobby $5/mo per service

### Slack
- [Unfurling links in messages | Slack Developer Docs](https://docs.slack.dev/messaging/unfurling-links-in-messages/)
- [chat.unfurl method | Slack Developer Docs](https://docs.slack.dev/reference/methods/chat.unfurl/)
- [link_shared event | Slack Developer Docs](https://docs.slack.dev/reference/events/link_shared/)
- [Card block | Slack Developer Docs](https://docs.slack.dev/reference/block-kit/blocks/card-block/) — Note: not documented as supported inside `chat.unfurl`
- [URL source element | Slack Developer Docs](https://docs.slack.dev/reference/block-kit/block-elements/url-source-element/) — restricted to `task_card` blocks
- [Everything you wanted to know about unfurling | Slack Platform Blog](https://medium.com/slack-developer-blog/everything-you-ever-wanted-to-know-about-unfurling-but-were-afraid-to-ask-or-how-to-make-your-e64b4bb9254)

### In-repo references
- `apps/pi-mom/lib/slack-ui-context.mjs:418-540` — `notify` + `postFile` patterns to mirror for `postPreview`
- `extensions/slack-interactive-tools.ts:222-300` — `slack_post_artifact` tool to mirror for `slack_post_preview`
- `apps/pi-mom/lib/routes.mjs:1-12` — `ARTIFACT_INSTRUCTION` to rephrase
- `apps/pi-mom/manifest.yaml:70-71` — `links:read` / `links:write` scopes (already granted)
- `apps/pi-mom/manifest.yaml:93-98` — `bot_events` (would need `link_shared` added for the deferred T2 path)
- `apps/pi-mom/railway.toml` + `nixpacks.toml` — Nixpacks + Bun pattern to mirror in `apps/pi-preview/`
- `BOUNDARY.md` — secrets-only-in-Railway rule; `PREVIEW_SHARED_SECRET` ships only as `.env.example` placeholder
- `docs/research/2026-05-12/issues/03-block-kit-ux.md` — proposed 60-LOC `lib/blocks.mjs` DSL; the T2 unfurl handler would consume it once it lands
