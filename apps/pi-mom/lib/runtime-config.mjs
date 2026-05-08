import { join } from "node:path";

export const REQUIRED_ENV = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];

export const SLACK_TOKEN_PREFIXES = {
  SLACK_BOT_TOKEN: "xoxb-",
  SLACK_APP_TOKEN: "xapp-",
};

export const LINEAR_DEFAULT_TARGET = {
  teamId: "c9c8376e-7fd3-4921-9996-8c98fc2274f2", // Frontend Engineering / FE
  projectId: "ba9682e2-c14e-4208-98a2-a89f3fb285b8", // Distribution
  stateId: "adfdb6e9-b118-4d65-ada3-ad11087b7dab", // Backlog
};

export const DEFAULT_IMAGE_OUTPUT_DIR_PARTS = [".pi", "agent", "generated-images", "slack"];

export function boundedIntegerEnv(env, name, fallback, { min, max }) {
  const parsed = Number(env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export function loadRuntimeConfig(env = process.env, { cwd = process.cwd(), startedAt = new Date() } = {}) {
  const mode = env.PI_MOM_MODE || "echo";
  const streamingRaw = env.PI_MOM_STREAMING || "true";
  const homeOrCwd = env.HOME || cwd;

  return {
    env,
    requiredEnv: REQUIRED_ENV,
    startedAt,
    mode,
    traceEnabled: env.PI_MOM_TRACE !== "false",
    slack: {
      botToken: env.SLACK_BOT_TOKEN || "",
      appToken: env.SLACK_APP_TOKEN || "",
      testChannelName: env.SLACK_TEST_CHANNEL_NAME || "idea-specs",
      allowedChannelId: env.SLACK_ALLOWED_CHANNEL_ID || "",
      expectedBotUser: env.EXPECTED_SLACK_BOT_USER || "covent_pi",
      allowAnyChannel: env.PI_MOM_ALLOW_ANY_CHANNEL === "true",
      teamId: env.SLACK_TEAM_ID || "",
      debugEnabled: env.PI_MOM_DEBUG === "true",
    },
    streaming: {
      raw: streamingRaw,
      enabled: streamingRaw === "true",
      appendChars: Math.max(1000, Number(env.PI_MOM_STREAM_APPEND_CHARS || 8000)),
      bufferChars: Math.max(1, Number(env.PI_MOM_STREAM_BUFFER_CHARS || 1)),
    },
    pi: {
      command: env.PI_COMMAND || "pi",
      extraArgs: (env.PI_EXTRA_ARGS || "").split(/\s+/).filter(Boolean),
      maxSlackText: Number(env.MAX_SLACK_TEXT || 38000),
      timeoutMs: Number(env.PI_TIMEOUT_MS || 180000),
      outputIdleMs: Number(env.PI_OUTPUT_IDLE_MS || 2000),
      allowTools: env.PI_MOM_ALLOW_PI_TOOLS === "true",
      workdir: env.PI_WORKDIR || env.HOME || cwd,
    },
    image: {
      routeEnabled: env.PI_MOM_IMAGE_ROUTE_ENABLED !== "false",
      apiKey: env.OPENAI_API_KEY || "",
      outputDir: env.PI_MOM_IMAGE_OUTPUT_DIR || join(homeOrCwd, ...DEFAULT_IMAGE_OUTPUT_DIR_PARTS),
      model: env.OPENAI_IMAGE_MODEL || "gpt-image-1",
      size: env.OPENAI_IMAGE_SIZE || "1024x1024",
      quality: env.OPENAI_IMAGE_QUALITY || "low",
      outputFormat: env.OPENAI_IMAGE_OUTPUT_FORMAT || "png",
      background: env.OPENAI_IMAGE_BACKGROUND || "auto",
      maxInputs: boundedIntegerEnv(env, "PI_MOM_IMAGE_MAX_INPUTS", 4, { min: 0, max: 16 }),
      maxBytes: boundedIntegerEnv(env, "PI_MOM_IMAGE_MAX_BYTES", 20 * 1024 * 1024, { min: 1024 * 1024, max: 50 * 1024 * 1024 }),
    },
    linear: {
      apiKey: env.LINEAR_API_KEY || "",
      apiUrl: env.LINEAR_API_URL || "https://api.linear.app/graphql",
      teamId: env.LINEAR_TEAM_ID || LINEAR_DEFAULT_TARGET.teamId,
      projectId: env.LINEAR_PROJECT_ID || LINEAR_DEFAULT_TARGET.projectId,
      stateId: env.LINEAR_STATE_ID || LINEAR_DEFAULT_TARGET.stateId,
    },
  };
}

export function getRuntimeConfigErrors(config) {
  const missing = config.requiredEnv.filter((key) => !config.env[key]);
  if (missing.length > 0) return missing.map((key) => `Missing ${key}.`);

  if (!["echo", "pi"].includes(config.mode)) {
    return [`Invalid PI_MOM_MODE=${config.mode}. Expected echo or pi.`];
  }

  if (!["true", "false"].includes(config.streaming.raw)) {
    return [`Invalid PI_MOM_STREAMING=${config.streaming.raw}. Expected true or false.`];
  }

  if (config.mode === "pi" && !config.slack.allowedChannelId && !config.slack.allowAnyChannel) {
    return ["SLACK_ALLOWED_CHANNEL_ID is required in PI_MOM_MODE=pi. Set PI_MOM_ALLOW_ANY_CHANNEL=true to override for local testing."];
  }

  return [];
}

export const runtimeConfig = loadRuntimeConfig();
