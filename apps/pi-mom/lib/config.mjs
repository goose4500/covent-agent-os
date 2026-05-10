import { join } from "node:path";

export const LINEAR_DEFAULTS = Object.freeze({
  apiUrl: "https://api.linear.app/graphql",
  teamId: "c9c8376e-7fd3-4921-9996-8c98fc2274f2",
  projectId: "ba9682e2-c14e-4208-98a2-a89f3fb285b8",
  stateId: "adfdb6e9-b118-4d65-ada3-ad11087b7dab",
});

export function envBoolean(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function boundedIntegerEnv(env, name, fallback, { min, max }) {
  const parsed = Number(env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export function readConfig(env = process.env, { cwd = process.cwd(), home = env.HOME || cwd } = {}) {
  const errors = [];
  const warnings = [];
  const mode = env.PI_MOM_MODE || "echo";
  const streamingValue = env.PI_MOM_STREAMING || "true";
  const agentRunnerMode = env.PI_MOM_AGENT_RUNNER || "fake";
  const allowedChannelId = env.SLACK_ALLOWED_CHANNEL_ID || "";
  const allowAnyChannel = env.PI_MOM_ALLOW_ANY_CHANNEL === "true";
  const nodeEnv = env.NODE_ENV || "";

  for (const key of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]) {
    if (!env[key]) errors.push(`Missing ${key}.`);
  }
  if (!["echo", "pi"].includes(mode)) errors.push(`Invalid PI_MOM_MODE=${mode}. Expected echo or pi.`);
  if (!["true", "false"].includes(streamingValue)) errors.push(`Invalid PI_MOM_STREAMING=${streamingValue}. Expected true or false.`);
  if (mode === "pi" && !allowedChannelId && !allowAnyChannel) {
    errors.push("SLACK_ALLOWED_CHANNEL_ID is required in PI_MOM_MODE=pi. Set PI_MOM_ALLOW_ANY_CHANNEL=true to override for local testing.");
  }
  if (allowAnyChannel && nodeEnv === "production") {
    errors.push("PI_MOM_ALLOW_ANY_CHANNEL=true is not allowed when NODE_ENV=production.");
  }
  if (!["fake", "repo-health"].includes(agentRunnerMode)) {
    errors.push(`Invalid PI_MOM_AGENT_RUNNER=${agentRunnerMode}. Expected fake or repo-health.`);
  }
  if (allowAnyChannel) warnings.push("PI_MOM_ALLOW_ANY_CHANNEL=true allows all Slack channels; use only for local testing.");

  return {
    errors,
    warnings,
    testChannelName: env.SLACK_TEST_CHANNEL_NAME || "idea-specs",
    allowedChannelId,
    expectedSlackBotUser: env.EXPECTED_SLACK_BOT_USER || "covent_pi",
    mode,
    streamingEnabled: streamingValue === "true",
    streamAppendChars: Math.max(1000, Number(env.PI_MOM_STREAM_APPEND_CHARS || 8000)),
    streamBufferChars: Math.max(1, Number(env.PI_MOM_STREAM_BUFFER_CHARS || 1)),
    allowAnyChannel,
    piCommand: env.PI_COMMAND || "pi",
    piExtraArgs: (env.PI_EXTRA_ARGS || "").split(/\s+/).filter(Boolean),
    maxSlackText: Number(env.MAX_SLACK_TEXT || 38000),
    piTimeoutMs: Number(env.PI_TIMEOUT_MS || 180000),
    piOutputIdleMs: Number(env.PI_OUTPUT_IDLE_MS || 2000),
    traceEnabled: env.PI_MOM_TRACE !== "false",
    imageRouteEnabled: env.PI_MOM_IMAGE_ROUTE_ENABLED !== "false",
    imageOutputDir: env.PI_MOM_IMAGE_OUTPUT_DIR || join(home, ".pi", "agent", "generated-images", "slack"),
    imageModel: env.OPENAI_IMAGE_MODEL || "gpt-image-1",
    imageSize: env.OPENAI_IMAGE_SIZE || "1024x1024",
    imageQuality: env.OPENAI_IMAGE_QUALITY || "low",
    imageOutputFormat: env.OPENAI_IMAGE_OUTPUT_FORMAT || "png",
    imageBackground: env.OPENAI_IMAGE_BACKGROUND || "auto",
    imageMaxInputs: boundedIntegerEnv(env, "PI_MOM_IMAGE_MAX_INPUTS", 4, { min: 0, max: 16 }),
    imageMaxBytes: boundedIntegerEnv(env, "PI_MOM_IMAGE_MAX_BYTES", 20 * 1024 * 1024, { min: 1024 * 1024, max: 50 * 1024 * 1024 }),
    agentRouteEnabled: env.PI_MOM_AGENT_ROUTE_ENABLED !== "false",
    agentRunnerMode,
    agentCanvasEnabled: env.PI_MOM_AGENT_CANVAS_ENABLED !== "false",
    agentMaxConcurrent: boundedIntegerEnv(env, "PI_MOM_AGENT_MAX_CONCURRENT", 1, { min: 1, max: 3 }),
    agentCommandTimeoutMs: boundedIntegerEnv(env, "PI_MOM_AGENT_COMMAND_TIMEOUT_MS", 60000, { min: 1000, max: 300000 }),
    runStatePath: env.PI_MOM_RUN_STATE_PATH || join(home, ".pi", "agent", "pi-mom", "runs.json"),
    repoHealthWorkdir: env.PI_MOM_REPO_HEALTH_WORKDIR || cwd,
    linearApiUrl: env.LINEAR_API_URL || LINEAR_DEFAULTS.apiUrl,
    linearTeamId: env.LINEAR_TEAM_ID || LINEAR_DEFAULTS.teamId,
    linearProjectId: env.LINEAR_PROJECT_ID || LINEAR_DEFAULTS.projectId,
    linearStateId: env.LINEAR_STATE_ID || LINEAR_DEFAULTS.stateId,
  };
}
