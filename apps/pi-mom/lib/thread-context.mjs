// thread-context — the structured-bundle builder used by `getThreadContext`.
//
// Owns:
//   1. Fetching the full Slack thread (via Worker B's fetcher).
//   2. Hydrating `m.files[]` (parallel `files.info`, per-file deadline).
//   3. Describing every image with Gemini (cache lookup → describeImage).
//   4. Atomic grouping (message + its images + files + unfurls).
//   5. Tier selection: N ≤ 40 → T0 (all raw); else → T1 (summarize older,
//      keep last 25 raw).
//   6. Rendering tail messages and building an attachments index.
//   7. Computing telemetry (prompt-size estimate) and persisting a
//      write-only summary entry for inspection.
//
// All third-party helpers are reachable via the `deps` injection seam so
// tests can drive the flow without touching the network, the disk, or
// Gemini. Production callers pass nothing and get the real implementations
// transparently.

import * as fetcherModule from "./slack-thread-fetcher.mjs";
import { describeImage as defaultDescribeImage } from "./image-describer.mjs";
import { summarizeOlder as defaultSummarizeOlder } from "./thread-summarizer.mjs";
import { estimatePromptSize } from "./token-estimator.mjs";
import * as summaryMapModule from "./thread-summary-map.mjs";

const TIER_THRESHOLD = 40;
const TAIL_SIZE = 25;
const IMAGE_DEADLINE_MS = 2500;

const defaultDeps = {
  fetchFullThread: fetcherModule.fetchFullThread,
  hydrateFiles: fetcherModule.hydrateFiles,
  downloadFileBytes: fetcherModule.downloadFileBytes,
  describeImage: defaultDescribeImage,
  summarizeOlder: defaultSummarizeOlder,
  summaryMap: { set: summaryMapModule.set, get: summaryMapModule.get },
};

/**
 * Normalize an unfurl/attachment URL for deduplication:
 *   - lowercase
 *   - drop trailing slash on the path
 *   - strip `utm_*` and `si` query params
 *
 * Anything we can't parse falls back to a lowercased trim of the input —
 * deduplication on weird inputs is best-effort, not load-bearing.
 */
export function normalizeUnfurlUrl(input) {
  if (!input || typeof input !== "string") return "";
  const raw = input.trim().toLowerCase();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw.replace(/\/+$/, "");
  }
  const params = parsed.searchParams;
  const toDelete = [];
  for (const key of params.keys()) {
    if (key === "si" || key.startsWith("utm_")) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) params.delete(key);
  parsed.search = params.toString();
  // Strip trailing slash from the path (unless the path itself IS "/").
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}

/**
 * Best-effort permalink. Slack messages don't return a `.permalink` by
 * default; the canonical archive URL is the documented synthesis form.
 */
function makePermalink(channel, ts) {
  if (!channel || !ts) return "";
  return `https://slack.com/archives/${channel}/p${String(ts).replace(".", "")}`;
}

/**
 * Group a message with its attached images/files/unfurls. Dedupe unfurls
 * by normalized URL. One group per message.
 *
 * `attachedImages` entries carry the Gemini description result (or an
 * error tag); `attachedFiles` entries carry hydrated `files.info` payloads
 * (or a `{ name, error }` stub); `attachedUnfurls` entries come from
 * `m.attachments[]` (Slack link unfurls).
 */
function buildAtomicGroups({ messages, hydratedByFileId, imageResultsByFileId }) {
  const groups = [];
  for (const m of messages) {
    const attachedImages = [];
    const attachedFiles = [];
    const attachedUnfurls = [];
    const seenUrls = new Set();

    if (Array.isArray(m.files)) {
      for (const f of m.files) {
        const fileId = f?.id || f?.file_id;
        const hydrated = (fileId && hydratedByFileId.get(fileId)) || f;
        // A hydrated record with `.error` is the "files.info failed" stub.
        if (hydrated && hydrated.error) {
          attachedFiles.push({
            fileId: fileId || null,
            name: hydrated.name || f?.name || "unavailable",
            error: hydrated.error,
          });
          continue;
        }
        const mimetype = hydrated?.mimetype || f?.mimetype || "";
        const isImage = typeof mimetype === "string" && mimetype.startsWith("image/");
        if (isImage) {
          const imageResult = fileId ? imageResultsByFileId.get(fileId) : null;
          attachedImages.push({
            fileId,
            name: hydrated?.name || f?.name || "image",
            mimetype,
            description: imageResult?.description,
            error: imageResult?.error,
            descSource: imageResult?.source,
            model: imageResult?.model,
          });
        } else {
          attachedFiles.push({
            fileId,
            name: hydrated?.name || f?.name || "file",
            mimetype,
            filetype: hydrated?.filetype,
            preview: hydrated?.preview,
          });
        }
      }
    }

    if (Array.isArray(m.attachments)) {
      for (const att of m.attachments) {
        // Skip Slack-internal "service" attachments that have no URL
        const url = att?.from_url || att?.original_url || att?.title_link;
        if (!url) continue;
        const norm = normalizeUnfurlUrl(url);
        if (norm && seenUrls.has(norm)) continue;
        if (norm) seenUrls.add(norm);
        attachedUnfurls.push({
          url,
          title: att?.title || "",
          excerpt: att?.text || att?.fallback || "",
          serviceName: att?.service_name,
        });
      }
    }

    groups.push({
      message: m,
      attachedImages,
      attachedFiles,
      attachedUnfurls,
    });
  }
  return groups;
}

/**
 * Render one atomic group for the raw-tail section. The exact whitespace
 * here is the contract the prompt builder relies on — keep it readable but
 * stable.
 */
function renderGroupForTail(group) {
  const m = group.message || {};
  const user = m.user ? `<@${m.user}>` : m.bot_id ? `<bot:${m.bot_id}>` : "<unknown>";
  const ts = m.ts || "?";
  const text = typeof m.text === "string" ? m.text : "";
  const lines = [`${user} [${ts}]: ${text}`];
  const indent = "  ";

  for (const img of group.attachedImages) {
    if (img.description) {
      lines.push(
        `${indent}[image#${img.fileId} AI-described by gemini-3.1-flash-lite — NOT a direct image input]`,
      );
      lines.push(`${indent}description: "${escapeForRender(img.description)}"`);
      lines.push(`${indent}to inspect visually: call read_image_content(file_id="${img.fileId}")`);
    } else {
      lines.push(
        `${indent}[image#${img.fileId} description: unavailable, source=${img.error || "unknown"}]`,
      );
      lines.push(`${indent}to inspect visually: call read_image_content(file_id="${img.fileId}")`);
    }
  }
  for (const f of group.attachedFiles) {
    if (f.error) {
      lines.push(`${indent}[file: unavailable, name=${f.name}]`);
      continue;
    }
    const preview = f.preview ? ` preview="${escapeForRender(truncate(f.preview, 240))}"` : "";
    lines.push(
      `${indent}[file#${f.fileId || "?"} name=${f.name} type=${f.mimetype || f.filetype || "unknown"}${preview}]`,
    );
  }
  for (const u of group.attachedUnfurls) {
    const excerpt = u.excerpt ? ` excerpt="${escapeForRender(truncate(u.excerpt, 200))}"` : "";
    lines.push(`${indent}[link url=${u.url} title="${escapeForRender(u.title)}"${excerpt}]`);
  }

  // Reactions live on the message object; surface them only when present.
  if (Array.isArray(m.reactions) && m.reactions.length > 0) {
    const parts = m.reactions
      .map((r) => `${r?.name || "?"}×${r?.count || 0}`)
      .join(", ");
    lines.push(`${indent}[reactions: ${parts}]`);
  }

  return lines.join("\n");
}

function truncate(str, n) {
  if (!str) return "";
  if (str.length <= n) return str;
  return str.slice(0, n) + "…";
}

function escapeForRender(s) {
  // Just escape embedded double-quotes; we render attribute-style values
  // with `="…"` wrappers and don't want them broken. Newlines we keep as-is
  // — the multimodal payloads we describe routinely contain them.
  return String(s || "").replace(/"/g, '\\"');
}

/**
 * Stable-ish hash of the file ids included in a summary, for telemetry.
 * Not a security primitive; just enough that the saved entry distinguishes
 * one fingerprint from another.
 */
function fingerprintFiles(groups) {
  const ids = [];
  for (const g of groups) {
    for (const img of g.attachedImages) if (img.fileId) ids.push(img.fileId);
    for (const f of g.attachedFiles) if (f.fileId) ids.push(f.fileId);
  }
  if (ids.length === 0) return "none";
  ids.sort();
  return ids.join(",");
}

/**
 * Walk hydrated files and produce a Promise.allSettled of describeImage
 * calls. The result map is keyed by fileId.
 */
async function runImageDescribePass({
  hydratedFiles,
  botToken,
  describeImage,
  downloadFileBytes,
}) {
  const images = hydratedFiles.filter((f) => {
    const m = f?.mimetype;
    return typeof m === "string" && m.startsWith("image/") && !f?.error;
  });
  if (images.length === 0) return new Map();

  const results = await Promise.allSettled(
    images.map(async (img) => {
      const fileId = img?.id || img?.file_id;
      const url = img?.url_private || img?.url_private_download;
      if (!fileId) return { fileId: null, error: "missing_file_id" };
      if (!url) return { fileId, error: "missing_url_private" };
      const download = await downloadFileBytes({
        url,
        botToken,
        deadlineMs: IMAGE_DEADLINE_MS,
      });
      if (!download || download.error) {
        return { fileId, error: download?.error || "download_failed" };
      }
      const desc = await describeImage({
        buffer: download.buffer,
        mimeType: download.mimeType || img.mimetype,
        fileId,
        deadlineMs: IMAGE_DEADLINE_MS,
      });
      if (desc?.error) {
        return { fileId, error: desc.error };
      }
      return {
        fileId,
        description: desc.description,
        model: desc.model,
        source: desc.source,
        builtAt: desc.builtAt,
      };
    }),
  );

  const byId = new Map();
  for (const r of results) {
    if (r.status === "fulfilled") {
      const v = r.value;
      if (v?.fileId) byId.set(v.fileId, v);
    }
    // Rejections are unexpected (we catch everything inside the lambda)
    // but if one slips through we just leave that image undescribed.
  }
  return byId;
}

/**
 * Build the flat attachments index — one entry per referenced file/link/canvas
 * across all groups. Lets the prompt's "Attachments" section enumerate
 * everything the agent could `read_image_content` against.
 */
function buildAttachmentsIndex(groups) {
  const out = [];
  for (const g of groups) {
    for (const img of g.attachedImages) {
      out.push({
        fileId: img.fileId,
        name: img.name,
        mimetype: img.mimetype,
        kind: "image",
        source: "thread",
      });
    }
    for (const f of g.attachedFiles) {
      // Slack's canvas surfaces as a file with filetype === "canvas".
      const kind = f.filetype === "canvas" ? "canvas" : "file";
      out.push({
        fileId: f.fileId || null,
        name: f.name,
        mimetype: f.mimetype || f.filetype || null,
        kind,
        source: "thread",
      });
    }
    for (const u of g.attachedUnfurls) {
      out.push({
        fileId: null,
        name: u.title || u.url,
        mimetype: null,
        kind: "link",
        source: "thread",
      });
    }
  }
  return out;
}

/**
 * Build the structured thread-context bundle. Entry point for the rest of
 * the system.
 *
 * @param {object} opts
 * @param {object} opts.client Slack WebClient
 * @param {string} opts.channel Slack channel id
 * @param {string} opts.rootTs Slack thread root ts
 * @param {string} [opts.route] Action route name (for telemetry only)
 * @param {string} [opts.botToken] Bot token for downloading image bytes
 * @param {object} [opts.deps] DI seam (see `defaultDeps`)
 *
 * @returns {Promise<{
 *   header: string,
 *   summaryBlock: string | null,
 *   rawTail: string[],
 *   attachments: Array<{ fileId, name, mimetype, kind, source }>,
 *   stats: object,
 * }>}
 */
export async function buildThreadContext({
  client,
  channel,
  rootTs,
  route,
  botToken,
  deps,
} = {}) {
  const d = { ...defaultDeps, ...(deps || {}) };

  // 1) Fetch.
  const fetched = await d.fetchFullThread({ client, channel, rootTs });
  const messages = Array.isArray(fetched?.messages) ? fetched.messages : [];
  const partial = !!fetched?.partial;

  // 2) Hydrate files. Collect all file refs from all messages; dedupe by id.
  const fileRefs = [];
  const seenFileIds = new Set();
  for (const m of messages) {
    if (!Array.isArray(m.files)) continue;
    for (const f of m.files) {
      const id = f?.id || f?.file_id;
      if (!id || seenFileIds.has(id)) continue;
      seenFileIds.add(id);
      fileRefs.push(f);
    }
  }
  let hydratedFiles = [];
  if (fileRefs.length > 0) {
    try {
      hydratedFiles = await d.hydrateFiles({ client, files: fileRefs });
      if (!Array.isArray(hydratedFiles)) hydratedFiles = [];
    } catch {
      hydratedFiles = [];
    }
  }
  const hydratedByFileId = new Map();
  for (const f of hydratedFiles) {
    const id = f?.id || f?.file_id;
    if (id) hydratedByFileId.set(id, f);
  }

  // 3) Image-description pass. Each image runs in parallel under
  // `Promise.allSettled`; per-image failures attach an `error` tag and
  // we move on.
  const imageResultsByFileId = await runImageDescribePass({
    hydratedFiles,
    botToken,
    describeImage: d.describeImage,
    downloadFileBytes: d.downloadFileBytes,
  });

  // 4) Atomic grouping.
  const groups = buildAtomicGroups({
    messages,
    hydratedByFileId,
    imageResultsByFileId,
  });

  // 5) Tier select.
  const tier = groups.length <= TIER_THRESHOLD ? "T0" : "T1";

  // 6-7) Tier path.
  let summaryBlock = null;
  let tailGroups;
  let hadSummarizerError = false;
  let summaryCutoffTs = null;
  let summaryEntry = null;

  if (tier === "T0") {
    tailGroups = groups;
  } else {
    const older = groups.slice(0, -TAIL_SIZE);
    tailGroups = groups.slice(-TAIL_SIZE);
    const summarizerResult = await d.summarizeOlder({ atomicGroups: older, route });
    if (summarizerResult?.error) {
      hadSummarizerError = true;
    }
    summaryBlock = summarizerResult?.summary ?? "";
    summaryCutoffTs = older.length > 0 ? older[older.length - 1]?.message?.ts || null : null;
    summaryEntry = {
      summary: summaryBlock,
      cutoffTs: summaryCutoffTs,
      fileFingerprint: fingerprintFiles(older),
      route: route || null,
      builtAt: Date.now(),
    };
  }

  // 8) Render the raw tail.
  const rawTail = tailGroups.map((g) => renderGroupForTail(g));

  // 9) Attachments index across ALL groups (so the agent can read any file
  // mentioned anywhere in the thread, not just the tail).
  const attachments = buildAttachmentsIndex(groups);

  // 10) Header. Best-effort permalink — Slack's `m.permalink` is not
  // standard, so we synthesize the canonical archive URL.
  const participants = new Set();
  for (const m of messages) {
    if (m?.user) participants.add(m.user);
  }
  const permalink = makePermalink(channel, rootTs);
  const header =
    `Thread: ${permalink} · ${participants.size} participants · ` +
    `${messages.length} messages · partial=${partial}`;

  // 12) Telemetry.
  const promptSize = estimatePromptSize({
    header,
    summaryBlock,
    rawTail,
    attachments,
  });
  // Pin the tier we actually chose so downstream telemetry isn't fooled by
  // the estimator's "summaryBlock present? → T1" heuristic on a T0 with
  // an empty older block.
  promptSize.tier = tier;

  const stats = {
    tier,
    msgCount: messages.length,
    fileCount: attachments.length,
    hadSummarizerError,
    partial,
    promptSize,
  };

  // Persist the summary entry write-only — read path does NOT consult this.
  if (summaryEntry && rootTs) {
    try {
      await d.summaryMap.set(rootTs, summaryEntry);
    } catch {
      /* telemetry only — failure here must not break the turn */
    }
  }

  return { header, summaryBlock, rawTail, attachments, stats };
}

// Test-only exports for white-box assertions.
export const _internals = {
  buildAtomicGroups,
  renderGroupForTail,
  buildAttachmentsIndex,
  fingerprintFiles,
  TIER_THRESHOLD,
  TAIL_SIZE,
};
