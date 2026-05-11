import { join } from "node:path";

export function boundedIntegerEnv(name, fallback, { min, max }, env = process.env) {
  const parsed = Number(env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

const requiredEnv = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing ${key}.`);
    process.exit(1);
  }
}

const mode = process.env.PI_MOM_MODE || "echo";
if (!["echo", "pi"].includes(mode)) {
  console.error(`Invalid PI_MOM_MODE=${mode}. Expected echo or pi.`);
  process.exit(1);
}

const streamingEnv = process.env.PI_MOM_STREAMING || "true";
if (!["true", "false"].includes(streamingEnv)) {
  console.error(`Invalid PI_MOM_STREAMING=${streamingEnv}. Expected true or false.`);
  process.exit(1);
}

const agentRunnerMode = process.env.PI_MOM_AGENT_RUNNER || "fake";
if (!["fake", "repo-health"].includes(agentRunnerMode)) {
  console.error(`Invalid PI_MOM_AGENT_RUNNER=${agentRunnerMode}. Expected fake or repo-health.`);
  process.exit(1);
}

const allowedChannelId = process.env.SLACK_ALLOWED_CHANNEL_ID || "";
if (mode === "pi" && !allowedChannelId && process.env.PI_MOM_ALLOW_ANY_CHANNEL !== "true") {
  console.error("SLACK_ALLOWED_CHANNEL_ID is required in PI_MOM_MODE=pi. Set PI_MOM_ALLOW_ANY_CHANNEL=true to override for local testing.");
  process.exit(1);
}

export const config = Object.freeze({
  testChannelName: process.env.SLACK_TEST_CHANNEL_NAME || "idea-specs",
  allowedChannelId,
  expectedSlackBotUser: process.env.EXPECTED_SLACK_BOT_USER || "covent_pi",
  mode,
  streamingEnabled: streamingEnv === "true",
  streamAppendChars: Math.max(1000, Number(process.env.PI_MOM_STREAM_APPEND_CHARS || 8000)),
  streamBufferChars: Math.max(1, Number(process.env.PI_MOM_STREAM_BUFFER_CHARS || 1)),
  piCommand: process.env.PI_COMMAND || "pi",
  piExtraArgs: (process.env.PI_EXTRA_ARGS || "").split(/\s+/).filter(Boolean),
  maxSlackText: Number(process.env.MAX_SLACK_TEXT || 38000),
  piTimeoutMs: Number(process.env.PI_TIMEOUT_MS || 180000),
  piOutputIdleMs: Number(process.env.PI_OUTPUT_IDLE_MS || 2000),
  traceEnabled: process.env.PI_MOM_TRACE !== "false",
  imageRouteEnabled: process.env.PI_MOM_IMAGE_ROUTE_ENABLED !== "false",
  imageOutputDir: process.env.PI_MOM_IMAGE_OUTPUT_DIR || join(process.env.HOME || process.cwd(), ".pi", "agent", "generated-images", "slack"),
  imageModel: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
  imageSize: process.env.OPENAI_IMAGE_SIZE || "1024x1024",
  imageQuality: process.env.OPENAI_IMAGE_QUALITY || "low",
  imageOutputFormat: process.env.OPENAI_IMAGE_OUTPUT_FORMAT || "png",
  imageBackground: process.env.OPENAI_IMAGE_BACKGROUND || "auto",
  imageMaxInputs: boundedIntegerEnv("PI_MOM_IMAGE_MAX_INPUTS", 4, { min: 0, max: 16 }),
  imageMaxBytes: boundedIntegerEnv("PI_MOM_IMAGE_MAX_BYTES", 20 * 1024 * 1024, { min: 1024 * 1024, max: 50 * 1024 * 1024 }),
  agentRouteEnabled: process.env.PI_MOM_AGENT_ROUTE_ENABLED !== "false",
  agentRunnerMode,
  agentCanvasEnabled: process.env.PI_MOM_AGENT_CANVAS_ENABLED !== "false",
  agentMaxConcurrent: boundedIntegerEnv("PI_MOM_AGENT_MAX_CONCURRENT", 1, { min: 1, max: 3 }),
  agentCommandTimeoutMs: boundedIntegerEnv("PI_MOM_AGENT_COMMAND_TIMEOUT_MS", 60000, { min: 1000, max: 300000 }),
  runStatePath: process.env.PI_MOM_RUN_STATE_PATH || join(process.env.HOME || process.cwd(), ".pi", "agent", "pi-mom", "runs.json"),
  repoHealthWorkdir: process.env.PI_MOM_REPO_HEALTH_WORKDIR || process.cwd(),
  linearApiUrl: process.env.LINEAR_API_URL || "https://api.linear.app/graphql",
  linearTeamId: process.env.LINEAR_TEAM_ID || "c9c8376e-7fd3-4921-9996-8c98fc2274f2",
  linearProjectId: process.env.LINEAR_PROJECT_ID || "ba9682e2-c14e-4208-98a2-a89f3fb285b8",
  linearStateId: process.env.LINEAR_STATE_ID || "adfdb6e9-b118-4d65-ada3-ad11087b7dab",
});
