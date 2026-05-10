import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSensitiveText } from "./redact.mjs";

const DEFAULT_BASE_URL = "https://api.browser-use.com/api/v3";
const DEFAULT_SECRET_FILE = path.join(os.homedir(), ".pi", "agent", "secrets", "browser-use.env");
const DEFAULT_RUN_DIR = path.join(os.homedir(), ".pi", "agent", "browser-use-runs");
const TERMINAL_STATUSES = new Set(["idle", "stopped", "error", "timed_out"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripQuotes(value) {
  const trimmed = String(value ?? "").trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnv(content) {
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = stripQuotes(match[2]);
  }
  return env;
}

export const redactBrowserUseSecrets = redactSensitiveText;

export async function getBrowserUseApiKey(options = {}) {
  if (process.env.BROWSER_USE_API_KEY) return process.env.BROWSER_USE_API_KEY.trim();

  const secretFile = options.secretFile || process.env.BROWSER_USE_ENV_FILE || DEFAULT_SECRET_FILE;
  if (!existsSync(secretFile)) {
    throw new Error(
      `Missing Browser Use API key. Set BROWSER_USE_API_KEY or create ${secretFile} with BROWSER_USE_API_KEY=...`,
    );
  }

  const content = await readFile(secretFile, "utf8");
  const parsed = parseEnv(content);
  const key = parsed.BROWSER_USE_API_KEY?.trim();
  if (!key) {
    throw new Error(`Missing BROWSER_USE_API_KEY in ${secretFile}`);
  }
  return key;
}

function removeUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

async function browserUseFetch(apiKey, endpoint, options = {}) {
  const baseUrl = options.baseUrl || process.env.BROWSER_USE_BASE_URL || DEFAULT_BASE_URL;
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Browser-Use-API-Key": apiKey,
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const safeBody = redactBrowserUseSecrets(typeof data === "string" ? data : JSON.stringify(data));
    throw new Error(`Browser Use API ${response.status}: ${safeBody}`);
  }
  return data;
}

function sessionStatus(session) {
  const raw = session?.status;
  if (raw && typeof raw === "object" && "value" in raw) return raw.value;
  return raw;
}

function isSessionDone(session) {
  const status = sessionStatus(session);
  if (!TERMINAL_STATUSES.has(status)) return false;
  if (status === "idle") {
    return session?.output !== null && session?.output !== undefined || session?.isTaskSuccessful !== null && session?.isTaskSuccessful !== undefined;
  }
  return true;
}

export async function runBrowserUseTask(options = {}) {
  const task = String(options.task || "").trim();
  if (!task) throw new Error("Browser Use task is required.");

  const apiKey = await getBrowserUseApiKey({ secretFile: options.secretFile });
  const signal = options.signal;
  const timeoutMs = Number(options.timeoutMs ?? 180_000);
  const pollIntervalMs = Number(options.pollIntervalMs ?? 3_000);
  const startedAt = Date.now();

  const body = removeUndefined({
    task,
    model: options.model || "gemini-3-flash",
    keepAlive: options.keepAlive ?? false,
    maxCostUsd: options.maxCostUsd ?? 0.5,
    profileId: options.profileId,
    workspaceId: options.workspaceId,
    proxyCountryCode: Object.prototype.hasOwnProperty.call(options, "proxyCountryCode") ? options.proxyCountryCode : null,
    outputSchema: options.outputSchema,
    enableRecording: options.enableRecording ?? true,
    enableSkills: options.enableSkills ?? false,
    agentmail: options.agentmail,
    cacheScript: options.cacheScript,
    validateCachedScript: options.validateCachedScript,
  });

  const session = await browserUseFetch(apiKey, "/sessions", {
    method: "POST",
    body,
    signal,
    baseUrl: options.baseUrl,
  });

  let latest = session;
  while (!isSessionDone(latest)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for Browser Use session ${latest?.id || "unknown"}`);
    }
    await sleep(pollIntervalMs);
    latest = await browserUseFetch(apiKey, `/sessions/${latest.id}`, {
      signal,
      baseUrl: options.baseUrl,
    });
  }

  const finishedAt = Date.now();
  const run = {
    task,
    request: {
      model: body.model,
      keepAlive: body.keepAlive,
      maxCostUsd: body.maxCostUsd,
      proxyCountryCode: body.proxyCountryCode,
      enableRecording: body.enableRecording,
      enableSkills: body.enableSkills,
    },
    session: latest,
    status: sessionStatus(latest),
    durationMs: finishedAt - startedAt,
    savedAt: new Date(finishedAt).toISOString(),
  };

  const outputDir = options.outputDir || DEFAULT_RUN_DIR;
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const stamp = new Date(finishedAt).toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(outputDir, `browser-use-run-${stamp}.json`);
  await writeFile(outputPath, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600).catch(() => {});

  return { ...run, outputPath };
}

export function formatBrowserUseRun(run) {
  const s = run.session || {};
  const output = s.output === undefined || s.output === null ? "[no output]" : typeof s.output === "string" ? s.output : JSON.stringify(s.output, null, 2);
  const lines = [
    `Browser Use session: ${s.id || "unknown"}`,
    `Status: ${run.status}`,
    `Successful: ${s.isTaskSuccessful ?? "unknown"}`,
    `Duration: ${Math.round((run.durationMs || 0) / 1000)}s`,
    s.liveUrl ? `Live URL: ${s.liveUrl}` : undefined,
    Array.isArray(s.recordingUrls) && s.recordingUrls.length ? `Recording URLs: ${s.recordingUrls.length} saved in metadata` : undefined,
    `Metadata: ${run.outputPath}`,
    "",
    "Output:",
    output,
  ].filter(Boolean);
  return redactBrowserUseSecrets(lines.join("\n"));
}
