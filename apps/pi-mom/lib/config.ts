import { join } from "node:path";

const REQUIRED_KEYS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] as const;

export type Config = Readonly<{
  startedAt: Date;
  slack: Readonly<{
    botToken: string;
    appToken: string;
    testChannelName: string;
    allowedChannelId: string;
    allowAnyChannel: boolean;
    expectedBotUser: string;
    initialTeamId: string;
    maxTextChars: number;
    debug: boolean;
  }>;
  pi: Readonly<{
    mode: "echo" | "pi";
    streamingEnabled: boolean;
    streamAppendChars: number;
    streamBufferChars: number;
    command: string;
    extraArgs: string[];
    timeoutMs: number;
    outputIdleMs: number;
    workdir: string;
    allowTools: boolean;
    traceEnabled: boolean;
  }>;
  image: Readonly<{
    routeEnabled: boolean;
    outputDir: string;
    model: string;
    size: string;
    quality: string;
    outputFormat: string;
    background: string;
    maxInputs: number;
    maxBytes: number;
    apiKey: string;
  }>;
  linear: Readonly<{
    apiUrl: string;
    teamId: string;
    projectId: string;
    stateId: string;
    apiKey: string;
  }>;
}>;

function boundedInt(
  value: string | undefined,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }

  const mode = (env.PI_MOM_MODE || "echo") as "echo" | "pi";
  if (mode !== "echo" && mode !== "pi") {
    throw new Error(`Invalid PI_MOM_MODE=${mode}. Expected echo or pi.`);
  }

  const streamingEnv = env.PI_MOM_STREAMING || "true";
  if (!["true", "false"].includes(streamingEnv)) {
    throw new Error(`Invalid PI_MOM_STREAMING=${streamingEnv}. Expected true or false.`);
  }

  const allowedChannelId = env.SLACK_ALLOWED_CHANNEL_ID || "";
  const allowAnyChannel = env.PI_MOM_ALLOW_ANY_CHANNEL === "true";
  if (mode === "pi" && !allowedChannelId && !allowAnyChannel) {
    throw new Error(
      "SLACK_ALLOWED_CHANNEL_ID is required in PI_MOM_MODE=pi. Set PI_MOM_ALLOW_ANY_CHANNEL=true to override for local testing.",
    );
  }

  const home = env.HOME || process.cwd();

  return Object.freeze({
    startedAt: new Date(),
    slack: Object.freeze({
      botToken: env.SLACK_BOT_TOKEN as string,
      appToken: env.SLACK_APP_TOKEN as string,
      testChannelName: env.SLACK_TEST_CHANNEL_NAME || "idea-specs",
      allowedChannelId,
      allowAnyChannel,
      expectedBotUser: env.EXPECTED_SLACK_BOT_USER || "covent_pi",
      initialTeamId: env.SLACK_TEAM_ID || "",
      maxTextChars: readNumber(env.MAX_SLACK_TEXT, 38000),
      debug: env.PI_MOM_DEBUG === "true",
    }),
    pi: Object.freeze({
      mode,
      streamingEnabled: streamingEnv === "true",
      streamAppendChars: Math.max(1000, readNumber(env.PI_MOM_STREAM_APPEND_CHARS, 8000)),
      streamBufferChars: Math.max(1, readNumber(env.PI_MOM_STREAM_BUFFER_CHARS, 1)),
      command: env.PI_COMMAND || "pi",
      extraArgs: (env.PI_EXTRA_ARGS || "").split(/\s+/).filter(Boolean),
      timeoutMs: readNumber(env.PI_TIMEOUT_MS, 180000),
      outputIdleMs: readNumber(env.PI_OUTPUT_IDLE_MS, 2000),
      workdir: env.PI_WORKDIR || home,
      allowTools: env.PI_MOM_ALLOW_PI_TOOLS === "true",
      traceEnabled: env.PI_MOM_TRACE !== "false",
    }),
    image: Object.freeze({
      routeEnabled: env.PI_MOM_IMAGE_ROUTE_ENABLED !== "false",
      outputDir: env.PI_MOM_IMAGE_OUTPUT_DIR || join(home, ".pi", "agent", "generated-images", "slack"),
      model: env.OPENAI_IMAGE_MODEL || "gpt-image-1",
      size: env.OPENAI_IMAGE_SIZE || "1024x1024",
      quality: env.OPENAI_IMAGE_QUALITY || "low",
      outputFormat: env.OPENAI_IMAGE_OUTPUT_FORMAT || "png",
      background: env.OPENAI_IMAGE_BACKGROUND || "auto",
      maxInputs: boundedInt(env.PI_MOM_IMAGE_MAX_INPUTS, 4, { min: 0, max: 16 }),
      maxBytes: boundedInt(env.PI_MOM_IMAGE_MAX_BYTES, 20 * 1024 * 1024, {
        min: 1024 * 1024,
        max: 50 * 1024 * 1024,
      }),
      apiKey: env.OPENAI_API_KEY || "",
    }),
    linear: Object.freeze({
      apiUrl: env.LINEAR_API_URL || "https://api.linear.app/graphql",
      teamId: env.LINEAR_TEAM_ID || "c9c8376e-7fd3-4921-9996-8c98fc2274f2",
      projectId: env.LINEAR_PROJECT_ID || "ba9682e2-c14e-4208-98a2-a89f3fb285b8",
      stateId: env.LINEAR_STATE_ID || "adfdb6e9-b118-4d65-ada3-ad11087b7dab",
      apiKey: env.LINEAR_API_KEY || "",
    }),
  });
}
