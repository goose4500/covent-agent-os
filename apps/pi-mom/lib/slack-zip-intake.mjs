import { inflateRawSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";

export const DEFAULT_ZIP_INTAKE_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_ZIP_INTAKE_BASE_DIR = "/tmp/pi-slack-attachments";

export class SlackZipIntakeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SlackZipIntakeError";
    this.code = code;
    this.details = details;
  }
}

export function isZipLikeFile(file = {}) {
  const name = String(file.name || file.title || "").toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();
  const filetype = String(file.filetype || "").toLowerCase();
  const prettyType = String(file.pretty_type || "").toLowerCase();
  return (
    name.endsWith(".zip") ||
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    filetype === "zip" ||
    prettyType.includes("zip")
  );
}

export function sanitizeSlackFilename(name = "upload.zip") {
  const leaf = basename(String(name || "upload.zip")).replace(/[\u0000-\u001f\u007f]/g, "");
  const safe = leaf.replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  return safe || "upload.zip";
}

export function directoryForSlackThread({ baseDir = DEFAULT_ZIP_INTAKE_BASE_DIR, channel, threadTs }) {
  const safeChannel = String(channel || "unknown-channel").replace(/[^A-Za-z0-9._-]/g, "_");
  const safeThreadTs = String(threadTs || "unknown-thread").replace(/[^A-Za-z0-9._-]/g, "_");
  return resolve(baseDir, `${safeChannel}-${safeThreadTs}`);
}

export function findShareContext(file = {}, preferredChannel) {
  const shares = file.shares || {};
  for (const bucket of [shares.public, shares.private]) {
    if (!bucket || typeof bucket !== "object") continue;
    const channels = preferredChannel && bucket[preferredChannel]
      ? [preferredChannel]
      : Object.keys(bucket);
    for (const channel of channels) {
      const shareList = Array.isArray(bucket[channel]) ? bucket[channel] : [];
      const share = shareList[0];
      if (!share) continue;
      const ts = share.thread_ts || share.ts;
      if (channel && ts) return { channel, threadTs: ts, messageTs: share.ts || ts };
    }
  }
  return {};
}

function assertSafeZipPath(entryName, outDir) {
  if (!entryName || entryName.includes("\0")) {
    throw new SlackZipIntakeError("zip_slip", `Refusing unsafe zip entry path: ${entryName || "(empty)"}`);
  }
  if (isAbsolute(entryName) || /^[A-Za-z]:[\\/]/.test(entryName) || entryName.split(/[\\/]+/).includes("..")) {
    throw new SlackZipIntakeError("zip_slip", `Refusing unsafe zip entry path: ${entryName}`);
  }
  const target = resolve(outDir, entryName);
  const root = resolve(outDir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new SlackZipIntakeError("zip_slip", `Refusing unsafe zip entry path: ${entryName}`);
  }
  return target;
}

function readUInt16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (readUInt32(buffer, offset) === 0x06054b50) return offset;
  }
  throw new SlackZipIntakeError("invalid_zip", "Could not find zip central directory");
}

export function listZipEntriesFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = readUInt16(buffer, eocd + 10);
  const centralDirectoryOffset = readUInt32(buffer, eocd + 16);
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (readUInt32(buffer, offset) !== 0x02014b50) {
      throw new SlackZipIntakeError("invalid_zip", "Invalid zip central directory header");
    }
    const compressionMethod = readUInt16(buffer, offset + 10);
    const compressedSize = readUInt32(buffer, offset + 20);
    const uncompressedSize = readUInt32(buffer, offset + 24);
    const nameLength = readUInt16(buffer, offset + 28);
    const extraLength = readUInt16(buffer, offset + 30);
    const commentLength = readUInt16(buffer, offset + 32);
    const localHeaderOffset = readUInt32(buffer, offset + 42);
    const path = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({
      path,
      directory: path.endsWith("/"),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export async function safelyExtractZip({ zipPath, outDir }) {
  const buffer = await readFile(zipPath);
  const entries = listZipEntriesFromBuffer(buffer);
  const extractedFiles = [];

  // Validate every archive entry before writing anything into extracted/.
  for (const entry of entries) {
    assertSafeZipPath(entry.path, outDir);
    if (!entry.directory && ![0, 8].includes(entry.compressionMethod)) {
      throw new SlackZipIntakeError("unsupported_zip_compression", `Unsupported zip compression method ${entry.compressionMethod} for ${entry.path}`);
    }
  }

  await mkdir(outDir, { recursive: true });

  for (const entry of entries) {
    const target = assertSafeZipPath(entry.path, outDir);
    if (entry.directory) {
      await mkdir(target, { recursive: true });
      continue;
    }

    if (readUInt32(buffer, entry.localHeaderOffset) !== 0x04034b50) {
      throw new SlackZipIntakeError("invalid_zip", `Invalid local file header for ${entry.path}`);
    }
    const localNameLength = readUInt16(buffer, entry.localHeaderOffset + 26);
    const localExtraLength = readUInt16(buffer, entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

    let contents;
    if (entry.compressionMethod === 0) {
      contents = Buffer.from(compressed);
    } else {
      contents = inflateRawSync(compressed);
    }

    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, contents);
    extractedFiles.push({ path: entry.path, bytes: contents.length });
  }

  return {
    entries: entries.map(({ path, directory, uncompressedSize, compressedSize }) => ({
      path,
      directory,
      bytes: uncompressedSize,
      compressedBytes: compressedSize,
    })),
    extractedFiles,
  };
}

export async function intakeSlackZipFile({
  client,
  botToken = process.env.SLACK_BOT_TOKEN,
  fileId,
  fileInfo,
  channel,
  threadTs,
  baseDir = DEFAULT_ZIP_INTAKE_BASE_DIR,
  maxBytes = Number(process.env.SLACK_ZIP_INTAKE_MAX_BYTES || DEFAULT_ZIP_INTAKE_MAX_BYTES),
  fetchImpl = globalThis.fetch,
  trace = () => {},
} = {}) {
  if (!client?.files?.info) throw new Error("intakeSlackZipFile requires client.files.info");
  if (!fileId) throw new Error("intakeSlackZipFile requires fileId");
  if (!fetchImpl) throw new Error("intakeSlackZipFile requires fetch");

  const info = fileInfo || await client.files.info({ file: fileId });
  const file = info?.file || {};
  const shareContext = findShareContext(file, channel);
  const resolvedChannel = channel || shareContext.channel;
  const resolvedThreadTs = threadTs || shareContext.threadTs || file.created?.toString?.() || file.timestamp || fileId;
  const size = Number(file.size || 0);

  const fileSummary = {
    id: file.id || fileId,
    name: file.name || file.title || fileId,
    size,
    mimetype: file.mimetype || "",
    filetype: file.filetype || "",
  };

  if (!isZipLikeFile(file)) {
    return { ok: false, skipped: true, reason: "not_zip", channel: resolvedChannel, threadTs: resolvedThreadTs, file: fileSummary };
  }

  if (Number.isFinite(maxBytes) && maxBytes > 0 && size > maxBytes) {
    return { ok: false, skipped: true, reason: "oversize", maxBytes, channel: resolvedChannel, threadTs: resolvedThreadTs, file: fileSummary };
  }

  const downloadUrl = file.url_private_download || file.url_private;
  if (!downloadUrl) {
    return { ok: false, skipped: true, reason: "missing_download_url", channel: resolvedChannel, threadTs: resolvedThreadTs, file: fileSummary };
  }
  if (!botToken) {
    throw new SlackZipIntakeError("missing_bot_token", "Slack bot token is required to download private Slack files");
  }

  const dir = directoryForSlackThread({ baseDir, channel: resolvedChannel, threadTs: resolvedThreadTs });
  await mkdir(dir, { recursive: true });
  const zipPath = resolve(dir, sanitizeSlackFilename(fileSummary.name));

  trace("slack_zip.download_start", { fileId: fileSummary.id, channel: resolvedChannel, threadTs: resolvedThreadTs, bytes: size });
  const response = await fetchImpl(downloadUrl, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!response?.ok) {
    throw new SlackZipIntakeError("download_failed", `Slack file download failed with HTTP ${response?.status || "unknown"}`);
  }
  const downloaded = Buffer.from(await response.arrayBuffer());
  if (Number.isFinite(maxBytes) && maxBytes > 0 && downloaded.length > maxBytes) {
    return { ok: false, skipped: true, reason: "oversize_download", maxBytes, channel: resolvedChannel, threadTs: resolvedThreadTs, file: fileSummary };
  }
  await writeFile(zipPath, downloaded);

  const extractDir = resolve(dir, "extracted");
  const { entries, extractedFiles } = await safelyExtractZip({ zipPath, outDir: extractDir });
  trace("slack_zip.extracted", { fileId: fileSummary.id, channel: resolvedChannel, threadTs: resolvedThreadTs, entries: entries.length });

  return {
    ok: true,
    skipped: false,
    channel: resolvedChannel,
    threadTs: resolvedThreadTs,
    file: fileSummary,
    zipPath,
    extractDir,
    entries,
    extractedFiles,
  };
}

export function formatSlackZipInventoryMessage(result) {
  if (!result?.ok) {
    const name = result?.file?.name || "file";
    if (result?.reason === "oversize" || result?.reason === "oversize_download") {
      return `Skipped Slack zip intake for \`${name}\`: file is over the configured max size.`;
    }
    return `Skipped Slack zip intake for \`${name}\`: ${result?.reason || "unsupported file"}.`;
  }

  const files = (result.extractedFiles || []).slice(0, 12);
  const more = Math.max(0, (result.extractedFiles || []).length - files.length);
  const fileLines = files.length
    ? files.map((entry) => `• \`${entry.path}\` (${entry.bytes} bytes)`).join("\n")
    : "• No files extracted.";
  const moreLine = more ? `\n• …and ${more} more file(s)` : "";

  return `✅ Extracted Slack zip upload \`${result.file?.name || "upload.zip"}\`.\n` +
    `*Extracted to:* \`${result.extractDir}\`\n` +
    `*Inventory:*\n${fileLines}${moreLine}\n\n` +
    `_Next hook: launch the \`slack-zip-handoff-analyzer\` subagent on this extracted directory and post its analysis back in this thread._`;
}
