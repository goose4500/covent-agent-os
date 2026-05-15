// covent-pi-preview — tiny static-bundle host for Pi-generated HTML previews.
//
// Architecture: covent-pi-mom POSTs a zip bundle over the private Railway
// network (http://covent-pi-preview.railway.internal:PORT/upload) with the
// shared secret. The zip MUST contain index.html at the root and MAY include
// sibling assets (CSS, JS, images). Bundles land on a Railway Volume mounted
// at PREVIEW_DIR; the public Railway domain serves them at /p/<slug>/<path>.
// /p/<slug>/ (or /p/<slug>/index.html) gets OG meta tags injected on the fly
// so Slack's link unfurl renders a summary card. 7-day TTL by default.
//
// No npm deps beyond fflate (zip create/extract); no DB; the filesystem is
// the index.

import { mkdir, writeFile, readFile, stat, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, normalize, relative } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { extractAndStore, injectOgTags, contentTypeFor } from "./lib/preview-core.mjs";

const ROOT = process.env.PREVIEW_DIR || "/data/previews";
const SECRET = process.env.PREVIEW_SHARED_SECRET || "";
const TTL_DAYS = Number(process.env.PREVIEW_TTL_DAYS || 7);
const TTL_MS = TTL_DAYS * 86_400_000;
const PORT = Number(process.env.PORT || 8080);
const BASE_PUBLIC = (process.env.PREVIEW_BASE_PUBLIC || "").replace(/\/$/, "");

if (!SECRET) {
  console.error("FATAL: PREVIEW_SHARED_SECRET is not set");
  process.exit(1);
}

await mkdir(ROOT, { recursive: true });

const slug = () => randomBytes(6).toString("base64url"); // ~8 chars, URL-safe
const isStale = (mtimeMs) => Date.now() - mtimeMs > TTL_MS;

async function deleteSlug(id) {
  const dir = join(ROOT, id);
  try { await rm(dir, { recursive: true, force: true }); } catch {}
}

async function sweep() {
  let removed = 0;
  for (const id of await readdir(ROOT).catch(() => [])) {
    try {
      const s = await stat(join(ROOT, id));
      if (isStale(s.mtimeMs)) { await deleteSlug(id); removed += 1; }
    } catch {}
  }
  if (removed > 0) console.log(`preview.sweep removed=${removed}`);
}
setInterval(sweep, 6 * 3600_000).unref?.();

function checkSecret(req) {
  return req.headers.get("x-preview-secret") === SECRET;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return new Response("ok");
    if (path === "/" || path === "") {
      return new Response("covent-pi-preview", { headers: { "content-type": "text/plain" } });
    }

    // PUT /upload — private, secret-gated. Body is a zip with index.html at root.
    if (path === "/upload" && req.method === "PUT") {
      if (!checkSecret(req)) return new Response("forbidden", { status: 403 });
      try {
        const buf = new Uint8Array(await req.arrayBuffer());
        const id = slug();
        const dir = join(ROOT, id);
        const entries = unzipSync(buf);
        await extractAndStore({ entries, dir, mkdir, writeFile });
        const url = `${BASE_PUBLIC || ""}/p/${id}/`;
        console.log(`preview.upload id=${id} entries=${Object.keys(entries).length} bytes=${buf.length}`);
        return Response.json({ id, url });
      } catch (err) {
        const msg = err?.message || String(err);
        console.log(`preview.upload_failed error=${msg}`);
        return new Response(`upload failed: ${msg}`, { status: 400 });
      }
    }

    // DELETE /p/<id> — secret-gated explicit cleanup before TTL.
    const delMatch = path.match(/^\/p\/([A-Za-z0-9_-]{4,16})\/?$/);
    if (delMatch && req.method === "DELETE") {
      if (!checkSecret(req)) return new Response("forbidden", { status: 403 });
      const id = delMatch[1];
      const exists = existsSync(join(ROOT, id));
      await deleteSlug(id);
      console.log(`preview.delete id=${id} existed=${exists}`);
      return new Response(exists ? "deleted" : "not_found", { status: exists ? 200 : 404 });
    }

    // GET /p/<id>/<rest?> — public bundle serve.
    const getMatch = path.match(/^\/p\/([A-Za-z0-9_-]{4,16})(\/.*)?$/);
    if (getMatch && (req.method === "GET" || req.method === "HEAD")) {
      const id = getMatch[1];
      const rest = (getMatch[2] || "/").replace(/^\/+/, "");
      const relPath = rest === "" || rest === "/" ? "index.html" : rest;
      const baseDir = join(ROOT, id);
      const target = normalize(join(baseDir, relPath));
      const rel = relative(baseDir, target);
      if (rel.startsWith("..") || rel === "" || rel.startsWith("/")) {
        return new Response("bad path", { status: 400 });
      }
      try {
        const s = await stat(target);
        if (isStale(s.mtimeMs)) {
          await deleteSlug(id);
          return new Response("expired", { status: 410 });
        }
        const ext = relPath.split(".").pop()?.toLowerCase() || "";
        let body = await readFile(target);
        if (ext === "html" || ext === "htm") {
          const html = injectOgTags(body.toString("utf8"), {
            slug: id,
            publicBase: BASE_PUBLIC,
            path: relPath,
          });
          body = Buffer.from(html, "utf8");
        }
        return new Response(body, {
          headers: {
            "content-type": contentTypeFor(ext),
            "cache-control": "public, max-age=60",
          },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`covent-pi-preview listening on :${PORT} root=${ROOT} ttl_days=${TTL_DAYS}`);
