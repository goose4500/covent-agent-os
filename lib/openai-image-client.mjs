import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const DEFAULT_OUTPUT_DIR = "~/.pi/agent/generated-images";
const DEFAULT_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const DEFAULT_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1024";
const DEFAULT_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "low";
const DEFAULT_OUTPUT_FORMAT = process.env.OPENAI_IMAGE_OUTPUT_FORMAT || "png";
const DEFAULT_BACKGROUND = process.env.OPENAI_IMAGE_BACKGROUND || "auto";
const MAX_INPUT_IMAGE_BYTES = Math.max(1024 * 1024, Number(process.env.OPENAI_IMAGE_MAX_INPUT_BYTES || 20 * 1024 * 1024) || 20 * 1024 * 1024);

const IMAGE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

export function expandHome(path) {
  if (!path) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function isImageMime(mimeType = "") {
  return mimeType.toLowerCase().startsWith("image/");
}

export function mimeToExtension(mimeType = "") {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/png") return "png";
  return "png";
}

export function guessMimeType(filePath = "") {
  return IMAGE_MIME_BY_EXTENSION.get(extname(filePath).toLowerCase()) || "image/png";
}

export function detectImageMime(buffer) {
  const bytes = Buffer.from(buffer);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export function bufferToDataUrl(buffer, mimeType = "image/png") {
  return `data:${mimeType};base64,${Buffer.from(buffer).toString("base64")}`;
}

export async function fileToDataUrl(filePath, mimeType = guessMimeType(filePath)) {
  const expandedPath = expandHome(filePath);
  const buffer = await readFile(expandedPath);
  if (buffer.length > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(`Input image is too large (${buffer.length} bytes > ${MAX_INPUT_IMAGE_BYTES}): ${expandedPath}`);
  }

  const detectedMime = detectImageMime(buffer);
  if (!detectedMime) {
    throw new Error(`Input file is not a supported PNG, JPEG, or WebP image: ${expandedPath}`);
  }

  const normalizedMime = isImageMime(mimeType) ? mimeType : detectedMime;
  return bufferToDataUrl(buffer, detectedMime || normalizedMime);
}

export function sanitizeForFilename(value = "image") {
  const cleaned = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "image";
}

function normalizeOutputFormat(format = DEFAULT_OUTPUT_FORMAT) {
  const value = String(format || DEFAULT_OUTPUT_FORMAT).toLowerCase();
  if (["png", "jpeg", "jpg", "webp"].includes(value)) return value === "jpg" ? "jpeg" : value;
  return DEFAULT_OUTPUT_FORMAT;
}

function imageFormatExtension(format = DEFAULT_OUTPUT_FORMAT) {
  return normalizeOutputFormat(format) === "jpeg" ? "jpg" : normalizeOutputFormat(format);
}

function normalizePositiveInteger(value, fallback, { min = 1, max = 10 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function optionalString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function modelCandidates(primaryModel) {
  const fallbacks = (process.env.OPENAI_IMAGE_MODEL_FALLBACKS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set([primaryModel || DEFAULT_MODEL, ...fallbacks])];
}

function shouldRetryWithFallback(errorPayload) {
  const message = `${errorPayload?.error?.message || errorPayload?.message || ""}`.toLowerCase();
  const code = `${errorPayload?.error?.code || ""}`.toLowerCase();
  return (
    code.includes("model") ||
    message.includes("model") ||
    message.includes("not found") ||
    message.includes("unsupported") ||
    message.includes("invalid")
  );
}

function compactErrorPayload(payload) {
  if (!payload) return "unknown_error";
  if (payload.error?.message) return payload.error.message;
  if (payload.message) return payload.message;
  try {
    return JSON.stringify(payload).slice(0, 1000);
  } catch {
    return String(payload).slice(0, 1000);
  }
}

async function postOpenAIImageRequest(endpoint, body, candidateModels) {
  let lastError;

  for (const candidateModel of candidateModels) {
    const requestBody = { ...body, model: candidateModel };
    const response = await fetch(`${OPENAI_BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const requestId = response.headers.get("x-request-id") || response.headers.get("openai-request-id") || undefined;
    const payload = await response.json().catch(async () => ({ message: await response.text().catch(() => "") }));

    if (response.ok) {
      return { payload, requestId, model: candidateModel };
    }

    lastError = { status: response.status, payload, requestId, model: candidateModel };
    if (!shouldRetryWithFallback(payload)) break;
  }

  const requestSuffix = lastError?.requestId ? ` request_id=${lastError.requestId}` : "";
  throw new Error(
    `OpenAI image request failed for model ${lastError?.model || "unknown"} (${lastError?.status || "unknown_status"}${requestSuffix}): ${compactErrorPayload(lastError?.payload)}`,
  );
}

function resultSummaryText(result) {
  const lines = [
    `${result.action === "edit" ? "Edited" : "Generated"} ${result.files.length} image(s) with ${result.model}.`,
    `metadata: ${result.metadataPath}`,
    "files:",
    ...result.files.map((file) => `- ${file.path}`),
  ];
  if (result.requestId) lines.splice(1, 0, `request_id: ${result.requestId}`);
  return lines.join("\n");
}

export async function createOpenAIImage({
  action = "generate",
  prompt,
  imagePaths = [],
  imageUrls = [],
  imageDataUrls = [],
  maskImageUrl,
  maskFileId,
  model = DEFAULT_MODEL,
  size = DEFAULT_SIZE,
  quality = DEFAULT_QUALITY,
  outputFormat = DEFAULT_OUTPUT_FORMAT,
  outputCompression,
  background = DEFAULT_BACKGROUND,
  moderation = "auto",
  inputFidelity,
  n = 1,
  outputDir = process.env.OPENAI_IMAGE_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
  prefix = "gpt-image",
  user,
} = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set; cannot call OpenAI image generation.");
  }

  const trimmedPrompt = optionalString(prompt);
  if (!trimmedPrompt) {
    throw new Error("prompt is required for OpenAI image generation.");
  }

  const normalizedAction = action === "edit" ? "edit" : "generate";
  const normalizedOutputFormat = normalizeOutputFormat(outputFormat);
  const body = {
    prompt: trimmedPrompt,
    size: optionalString(size) || DEFAULT_SIZE,
    quality: optionalString(quality) || DEFAULT_QUALITY,
    output_format: normalizedOutputFormat,
    background: optionalString(background) || DEFAULT_BACKGROUND,
    moderation: optionalString(moderation) || "auto",
    n: normalizePositiveInteger(n, 1),
  };

  if (user) body.user = String(user).slice(0, 256);
  if (outputCompression !== undefined && outputCompression !== null && outputCompression !== "") {
    body.output_compression = normalizePositiveInteger(outputCompression, 100, { min: 0, max: 100 });
  }

  const endpoint = normalizedAction === "edit" ? "/images/edits" : "/images/generations";
  let inputImageCount = 0;

  if (normalizedAction === "edit") {
    const dataUrlsFromFiles = [];
    for (const imagePath of imagePaths || []) {
      if (optionalString(imagePath)) dataUrlsFromFiles.push(await fileToDataUrl(imagePath));
    }

    const images = [
      ...(imageUrls || []).filter(optionalString).map((image_url) => ({ image_url })),
      ...(imageDataUrls || []).filter(optionalString).map((image_url) => ({ image_url })),
      ...dataUrlsFromFiles.map((image_url) => ({ image_url })),
    ];

    inputImageCount = images.length;
    if (!images.length) {
      throw new Error("image edit requires at least one input image path, URL, or data URL.");
    }

    body.images = images.slice(0, 16);
    if (inputFidelity && !String(model).includes("gpt-image-2")) body.input_fidelity = inputFidelity;
    if (maskImageUrl || maskFileId) {
      body.mask = maskFileId ? { file_id: maskFileId } : { image_url: maskImageUrl };
    }
  }

  const { payload, requestId, model: resolvedModel } = await postOpenAIImageRequest(endpoint, body, modelCandidates(model));
  const outputImages = Array.isArray(payload.data) ? payload.data : [];
  if (!outputImages.length) {
    throw new Error(`OpenAI image response had no data array. request_id=${requestId || "unknown"}`);
  }

  const expandedOutputDir = expandHome(outputDir);
  await mkdir(expandedOutputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safePrefix = sanitizeForFilename(prefix);
  const ext = imageFormatExtension(payload.output_format || normalizedOutputFormat);
  const files = [];

  for (let index = 0; index < outputImages.length; index += 1) {
    const image = outputImages[index];
    if (!image.b64_json) {
      throw new Error("OpenAI GPT image response did not include b64_json output.");
    }

    const filename = `${safePrefix}-${timestamp}-${String(index + 1).padStart(2, "0")}.${ext}`;
    const path = join(expandedOutputDir, filename);
    await writeFile(path, Buffer.from(image.b64_json, "base64"), { mode: 0o600 });
    files.push({
      path,
      filename,
      revisedPrompt: image.revised_prompt,
    });
  }

  const metadataPath = join(expandedOutputDir, `${safePrefix}-${timestamp}.json`);
  const metadata = {
    action: normalizedAction,
    model: resolvedModel,
    requestedModel: model,
    endpoint,
    requestId,
    created: payload.created,
    prompt: trimmedPrompt,
    options: {
      size: payload.size || body.size,
      quality: payload.quality || body.quality,
      background: payload.background || body.background,
      outputFormat: payload.output_format || normalizedOutputFormat,
      outputCompression: body.output_compression,
      moderation: body.moderation,
      n: body.n,
      inputFidelity: body.input_fidelity,
    },
    inputImageCount,
    files: files.map((file) => ({ ...file, baseName: basename(file.path) })),
    usage: payload.usage,
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

  const result = {
    ...metadata,
    metadataPath,
    files,
    summary: undefined,
  };
  result.summary = resultSummaryText(result);
  return result;
}
