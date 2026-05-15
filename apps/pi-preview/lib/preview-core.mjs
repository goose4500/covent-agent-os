// Pure helpers for covent-pi-preview, isolated for unit testing.
//
// extractAndStore validates a fflate unzipSync() result against a path-safety
// policy and writes each entry under the slug's directory. injectOgTags rewrites
// served HTML to add OpenGraph + Twitter Card meta so Slack's link unfurl shows
// a summary card without us doing screenshots. contentTypeFor maps a filename
// extension to a sensible Content-Type for the static serve path.

import { dirname, join, normalize, relative } from "node:path";

const ALLOWED_EXTS = new Set([
  "html", "htm", "css", "js", "mjs", "json", "txt", "md", "svg", "png", "jpg", "jpeg",
  "gif", "webp", "ico", "woff", "woff2", "ttf", "otf", "map", "wasm",
]);

const CT_MAP = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  map: "application/json; charset=utf-8",
  wasm: "application/wasm",
};

const MAX_FILES = 64;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

export function contentTypeFor(ext) {
  return CT_MAP[String(ext).toLowerCase()] || "application/octet-stream";
}

// Validate a single entry name from a zip — reject traversal, absolute paths,
// disallowed extensions, and empty/directory entries.
export function classifyEntryName(rawName) {
  if (!rawName || typeof rawName !== "string") return { ok: false, reason: "empty_name" };
  if (rawName.endsWith("/")) return { ok: false, reason: "directory_entry" };
  if (rawName.startsWith("/") || rawName.startsWith("\\")) return { ok: false, reason: "absolute_path" };
  const norm = normalize(rawName).replace(/\\/g, "/");
  if (norm.startsWith("../") || norm === ".." || norm.includes("/../")) {
    return { ok: false, reason: "path_traversal" };
  }
  if (norm.includes("\0")) return { ok: false, reason: "nul_byte" };
  const ext = norm.split(".").pop()?.toLowerCase() || "";
  if (!ALLOWED_EXTS.has(ext)) return { ok: false, reason: `disallowed_ext:${ext}` };
  return { ok: true, name: norm, ext };
}

// Walk a fflate unzipSync() result and write each entry under `dir`.
// Enforces MAX_FILES, MAX_BUNDLE_BYTES, and requires a top-level index.html.
// The mkdir + writeFile deps are injected so tests can swap a fake fs.
export async function extractAndStore({ entries, dir, mkdir, writeFile }) {
  const names = Object.keys(entries);
  if (names.length === 0) throw new Error("empty_zip");
  if (names.length > MAX_FILES) throw new Error(`too_many_files:${names.length}`);

  // Pass 1: validate and total bytes before touching disk.
  const accepted = [];
  let total = 0;
  for (const name of names) {
    const classified = classifyEntryName(name);
    if (!classified.ok) throw new Error(`reject_entry:${classified.reason}:${name}`);
    const bytes = entries[name];
    total += bytes.byteLength;
    if (total > MAX_BUNDLE_BYTES) throw new Error(`bundle_too_large:${total}`);
    accepted.push({ name: classified.name, bytes });
  }
  if (!accepted.some((e) => e.name === "index.html")) {
    throw new Error("missing_index_html");
  }

  // Pass 2: write to disk under the slug's dir.
  await mkdir(dir, { recursive: true });
  for (const { name, bytes } of accepted) {
    const target = join(dir, name);
    const targetDir = dirname(target);
    if (relative(dir, target).startsWith("..")) throw new Error(`reject_path:${name}`);
    if (targetDir !== dir) await mkdir(targetDir, { recursive: true });
    await writeFile(target, bytes);
  }
  return { count: accepted.length, bytes: total };
}

// Inject 4 OG/Twitter meta tags into served HTML so Slack auto-unfurl renders
// a summary card. Idempotent: if og:title is already present, leave the head
// alone (the user's own meta wins). Only injects when an opening <head> tag
// exists — otherwise returns the body untouched (raw fragments still serve).
export function injectOgTags(html, { slug, publicBase, path }) {
  if (typeof html !== "string") return html;
  if (/<meta[^>]+property=["']og:title["']/i.test(html)) return html;
  const headMatch = html.match(/<head\b[^>]*>/i);
  if (!headMatch) return html;
  const title = `Preview · ${slug}`;
  const url = `${publicBase || ""}/p/${slug}/${path === "index.html" ? "" : path}`;
  const tags = [
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    `<meta property="og:description" content="Generated preview · covent-pi">`,
    `<meta property="og:url" content="${escapeAttr(url)}">`,
    `<meta name="twitter:card" content="summary">`,
  ].join("\n  ");
  const insertAt = headMatch.index + headMatch[0].length;
  return html.slice(0, insertAt) + `\n  ${tags}` + html.slice(insertAt);
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const _internals = { ALLOWED_EXTS, MAX_FILES, MAX_BUNDLE_BYTES };
