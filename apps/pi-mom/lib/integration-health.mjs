import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BROWSER_USE_SECRET_FILE = join(homedir(), ".pi", "agent", "secrets", "browser-use.env");

function hasEnv(env, key) {
  return Boolean(String(env?.[key] || "").trim());
}

function browserUseSecretFileHasKey(fileExists, readFileSyncFn, path) {
  try {
    if (!fileExists(path)) return false;
    const content = String(readFileSyncFn(path, "utf8") || "");
    const match = content.match(/^\s*BROWSER_USE_API_KEY\s*=\s*(.+?)\s*$/m);
    if (!match) return false;
    const value = String(match[1] || "")
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .trim();
    return Boolean(value);
  } catch {
    return false;
  }
}

export function buildIntegrationHealth({
  env = process.env,
  slackClient,
  fileExists = existsSync,
  readFileSyncFn = readFileSync,
  browserUseSecretFile,
  linearTeamId = env.LINEAR_TEAM_ID,
  linearProjectId = env.LINEAR_PROJECT_ID,
  linearStateId = env.LINEAR_STATE_ID,
} = {}) {
  const slackStreamingAvailable = typeof slackClient?.chatStream === "function";

  const browserSecretPath = browserUseSecretFile || env.BROWSER_USE_ENV_FILE || DEFAULT_BROWSER_USE_SECRET_FILE;
  const browserUseEnvPresent = hasEnv(env, "BROWSER_USE_API_KEY");
  const browserUseSecretFilePresent = !browserUseEnvPresent && browserUseSecretFileHasKey(fileExists, readFileSyncFn, browserSecretPath);
  const browserUseKeyPresent = browserUseEnvPresent || browserUseSecretFilePresent;

  const linearKeyPresent = hasEnv(env, "LINEAR_API_KEY");
  const linearTargetPresent = Boolean(linearTeamId && linearProjectId && linearStateId);

  return {
    slackStreaming: {
      available: slackStreamingAvailable,
      ok: slackStreamingAvailable,
      label: slackStreamingAvailable ? "ok" : "missing client.chatStream",
    },
    browserUse: {
      keyPresent: browserUseKeyPresent,
      ok: browserUseKeyPresent,
      source: browserUseEnvPresent ? "env" : browserUseSecretFilePresent ? "secret file" : "missing",
      label: browserUseKeyPresent
        ? `configured (${browserUseEnvPresent ? "env" : "secret file"})`
        : "missing BROWSER_USE_API_KEY",
    },
    linear: {
      keyPresent: linearKeyPresent,
      targetPresent: linearTargetPresent,
      ok: linearKeyPresent && linearTargetPresent,
      label: linearKeyPresent && linearTargetPresent
        ? "configured"
        : !linearKeyPresent
          ? "LINEAR_API_KEY missing"
          : "target IDs missing",
    },
  };
}

export function formatIntegrationHealthLogLines(health = {}) {
  return [
    `Slack streaming support: ${health.slackStreaming?.label || "not checked"}`,
    `Browser Use key: ${health.browserUse?.label || "not checked"}`,
    `Linear config: ${health.linear?.label || "not checked"}`,
  ];
}

export function logIntegrationHealth(health, logger = console) {
  for (const line of formatIntegrationHealthLogLines(health)) {
    logger.log(`🩺 ${line}`);
  }
}
