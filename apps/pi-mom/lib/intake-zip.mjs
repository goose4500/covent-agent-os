// Intake helpers for receiving a Slack-uploaded zip of spec/notes/PDFs and
// extracting a small, in-memory file list for downstream agents to read.
//
// The two functions exported here are intentionally narrow and dependency-
// injected so they can be unit-tested without touching the network or the
// real Slack WebClient:
//
//   downloadSlackFile(client, fileId, opts)
//     Resolves a Slack `file_id` to its private download URL via
//     `client.files.info`, then fetches the bytes with the bot token in the
//     Authorization header (Slack's private files require this — a bare GET
//     returns an HTML login page). Enforces a single hard cap on response
//     size so a malicious upload cannot exhaust process memory.
//
//   extractZipBuffer(buffer, caps)
//     Synchronously parses a zip Buffer with `adm-zip` and produces a
//     bounded list of `{ name, relPath, text, mediaType, sizeBytes,
//     truncated }` entries plus a `skipped[]` list explaining anything that
//     was dropped. Caps protect against zip-bombs (huge uncompressed totals)
//     and runaway memory (tons of tiny entries, oversized single entries).
//     Only `.md`/`.markdown` and `.txt` are decoded as utf-8; `.pdf`/`.docx`
//     and anything else are returned with `text: null` and a media type so
//     a downstream parser can decide what to do.
//
// Both functions are pure w.r.t. logging: they never emit the file contents
// they handle. Only sizes, counts, and entry names ever escape this module.
// `process.env` is not read anywhere here — callers must pass the bot token
// explicitly so the orchestrator owns the secret lifecycle.

import AdmZip from "adm-zip";

const DEFAULT_MAX_BYTES = 25_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 25_000_000;
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_ENTRY_BYTES = 5_000_000;
const DEFAULT_TEXT_ENTRY_LIMIT_BYTES = 200_000;

function basename(relPath) {
  const cleaned = String(relPath || "").replace(/\\/g, "/");
  const idx = cleaned.lastIndexOf("/");
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function lowerExt(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot).toLowerCase();
}

function classify(ext) {
  switch (ext) {
    case ".md":
    case ".markdown":
      return "markdown";
    case ".txt":
      return "text";
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    default:
      return "binary";
  }
}

export async function downloadSlackFile(client, fileId, {
  fetchImpl = fetch,
  botToken,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!client || typeof client.files?.info !== "function") {
    throw new Error("intake-zip: client.files.info is required");
  }
  if (!fileId || typeof fileId !== "string") {
    throw new Error("intake-zip: fileId is required");
  }
  if (!botToken || typeof botToken !== "string") {
    throw new Error("intake-zip: botToken is required");
  }

  const info = await client.files.info({ file: fileId });
  const url = info?.file?.url_private_download;
  if (!url || typeof url !== "string") {
    throw new Error(`intake-zip: file ${fileId} has no url_private_download`);
  }

  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res || !res.ok || (typeof res.status === "number" && (res.status < 200 || res.status >= 300))) {
    const status = res?.status ?? "unknown";
    throw new Error(`intake-zip: download failed for ${fileId} (status ${status})`);
  }

  // Cheap pre-check via Content-Length if the server advertised one.
  const advertised = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new Error(`intake-zip: file ${fileId} exceeds maxBytes (${advertised} > ${maxBytes})`);
  }

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length > maxBytes) {
    throw new Error(`intake-zip: file ${fileId} exceeds maxBytes (${buf.length} > ${maxBytes})`);
  }
  return buf;
}

export function extractZipBuffer(buffer, {
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
  textEntryLimitBytes = DEFAULT_TEXT_ENTRY_LIMIT_BYTES,
} = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("intake-zip: buffer must be a Buffer");
  }

  const zip = new AdmZip(buffer);
  const rawEntries = zip.getEntries();

  const files = [];
  const skipped = [];
  let totalBytes = 0;
  let processedCount = 0;
  let capHit = null; // "entries" | "total" | null

  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i];
    const relPath = entry.entryName;
    const name = basename(relPath);

    // Skip directories.
    if (entry.isDirectory || relPath.endsWith("/")) continue;

    if (capHit === "entries") {
      skipped.push({ name, reason: "skipped: maxEntries cap" });
      continue;
    }
    if (capHit === "total") {
      skipped.push({ name, reason: "skipped: would exceed maxTotalBytes" });
      continue;
    }

    if (processedCount >= maxEntries) {
      capHit = "entries";
      skipped.push({ name, reason: "skipped: maxEntries cap" });
      continue;
    }

    const sizeBytes = Number(entry.header?.size ?? 0);
    if (Number.isFinite(sizeBytes) && sizeBytes > maxEntryBytes) {
      skipped.push({ name, reason: "entry too large (>maxEntryBytes)" });
      processedCount += 1;
      continue;
    }

    if (totalBytes + sizeBytes > maxTotalBytes) {
      capHit = "total";
      skipped.push({ name, reason: "skipped: would exceed maxTotalBytes" });
      continue;
    }

    const ext = lowerExt(name);
    const mediaType = classify(ext);

    if (mediaType === "markdown" || mediaType === "text") {
      const decoded = entry.getData().toString("utf8");
      let text = decoded;
      let truncated = false;
      if (text.length > textEntryLimitBytes) {
        text = text.slice(0, textEntryLimitBytes);
        truncated = true;
      }
      files.push({
        name,
        relPath,
        text,
        mediaType,
        sizeBytes,
        truncated,
      });
    } else {
      skipped.push({ name, reason: `binary file: not parsed in v1 (${ext || "no-ext"})` });
      files.push({
        name,
        relPath,
        text: null,
        mediaType,
        sizeBytes,
        truncated: false,
      });
    }

    totalBytes += sizeBytes;
    processedCount += 1;
  }

  return { files, skipped, totalBytes };
}
