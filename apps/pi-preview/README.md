# covent-pi-preview

Tiny Railway-hosted service that accepts zipped HTML bundles from `covent-pi-mom` and serves them publicly so Pi-generated previews can be opened (and run) in a browser from a Slack thread.

```
Slack thread       →  Pi generates HTML/CSS/JS  →  bot zips + PUTs over
@Covent-Agent          to /tmp/preview-<id>/        railway.internal
                                                          ↓
                                                   covent-pi-preview
                                                          ↓
                                                   /data/previews/<slug>/
                                                          ↓
            user clicks URL in Slack  ←  https://covent-pi-preview.up.railway.app/p/<slug>/
```

## What it serves

- `GET /p/<slug>/` and `GET /p/<slug>/index.html` — the bundle's `index.html` with 4 OG meta tags injected on the fly (so Slack auto-unfurls a summary card).
- `GET /p/<slug>/<path>` — any other file in the bundle (css/js/img). Path-safe; traversal returns 400.
- `GET /healthz` — `ok` for Railway healthcheck + the `railway-debugger` agent.

## What it accepts

- `PUT /upload` with `application/zip` body, header `x-preview-secret: <PREVIEW_SHARED_SECRET>`. Returns `{ id, url }`.
- `DELETE /p/<slug>` with the same secret header for explicit cleanup before TTL. Returns `200 deleted` or `404 not_found`.

Bundles must contain `index.html` at the zip root. Allowed extensions: html, css, js, mjs, json, txt, md, svg, png, jpg, gif, webp, ico, woff/woff2, ttf, otf, map, wasm. Hard caps: 64 files, 10 MB total bundle.

## TTL & cleanup

- Default 7 days (env `PREVIEW_TTL_DAYS`).
- Lazy check on every read — stale slugs return `410 Gone` and the directory is deleted.
- Background sweep every 6 hours for slugs that never get a read after expiry.

## Railway service setup (one-time)

1. In the `covent-pi-mom` project, create a new service `covent-pi-preview`.
2. Attach a **1 GB Volume mounted at `/data`** (Hobby plan max is 5 GB).
3. Generate the public **`*.up.railway.app`** domain.
4. Set variables on `covent-pi-preview`:
   - `PREVIEW_SHARED_SECRET=<openssl rand -hex 32>` — share with `covent-pi-mom`
   - `PREVIEW_BASE_PUBLIC=https://covent-pi-preview.up.railway.app`
   - `PREVIEW_TTL_DAYS=7` (optional, defaults to 7)
   - `PORT=8080` (optional, defaults to 8080)
   - `PREVIEW_DIR=/data/previews` (optional, defaults to this)
5. On `covent-pi-mom`, set:
   - `PREVIEW_BASE_INTERNAL=http://covent-pi-preview.railway.internal:8080`
   - `PREVIEW_BASE_PUBLIC=https://covent-pi-preview.up.railway.app`
   - `PREVIEW_SHARED_SECRET=<same value>`

Without these, `covent-pi-mom`'s `slack_post_preview` tool returns a clean "not configured" error to the model; the rest of the bot is unaffected.

## Local dev

```bash
cd apps/pi-preview
bun install
PREVIEW_SHARED_SECRET=test \
PREVIEW_BASE_PUBLIC=http://localhost:8080 \
PREVIEW_DIR=/tmp/covent-preview-dev \
  bun index.mjs

# Sanity check:
curl http://localhost:8080/healthz                 # → ok

# Build a one-file bundle and upload:
mkdir /tmp/bundle && cd /tmp/bundle
echo '<html><body><h1>hi</h1></body></html>' > index.html
zip -qr - . > /tmp/bundle.zip
curl -X PUT http://localhost:8080/upload \
  -H 'x-preview-secret: test' \
  -H 'content-type: application/zip' \
  --data-binary @/tmp/bundle.zip
# → {"id":"...","url":"http://localhost:8080/p/<id>/"}

# Open the URL — page should render with OG tags in <head>.
```

## Tests

```bash
bun run check                                      # unit tests for the pure helpers
```

## Operability

`railway logs --service covent-pi-preview` shows one structured line per upload/delete/sweep (`preview.upload id=<id> entries=<n> bytes=<n>`, `preview.delete`, `preview.sweep removed=<n>`).
