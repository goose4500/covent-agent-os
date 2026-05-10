import { PostHog } from "posthog-node";

const apiKey = process.env.POSTHOG_API_KEY || process.env.POSTHOG_PROJECT_API_KEY || "";
const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

const client = apiKey
  ? new PostHog(apiKey, {
      host,
      flushAt: Number(process.env.POSTHOG_FLUSH_AT || 20),
      flushInterval: Number(process.env.POSTHOG_FLUSH_INTERVAL_MS || 10000),
    })
  : undefined;

const MAX_AI_TEXT_CHARS = Math.max(500, Number(process.env.POSTHOG_AI_TEXT_CHARS || 6000));
const identifiedDistinctIds = new Set();

function clip(value) {
  if (typeof value !== "string") return value;
  if (value.length <= MAX_AI_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_AI_TEXT_CHARS)}…[truncated ${value.length - MAX_AI_TEXT_CHARS} chars]`;
}

export function posthogEnabled() {
  return Boolean(client);
}

export function track(event, properties = {}, { distinctId, groups } = {}) {
  if (!client) return;
  try {
    client.capture({
      distinctId: distinctId || properties.requestId || properties.user || "anonymous",
      event,
      properties,
      groups,
    });
  } catch {
    // PostHog must never break the bot.
  }
}

export function identifyOnce(distinctId, properties = {}) {
  if (!client || !distinctId) return;
  if (identifiedDistinctIds.has(distinctId)) return;
  identifiedDistinctIds.add(distinctId);
  try {
    client.identify({ distinctId, properties });
  } catch {
    // best-effort
  }
}

export function trackAIGeneration({
  distinctId,
  groups,
  provider,
  model,
  input,
  output,
  inputTokens,
  outputTokens,
  latencyMs,
  traceId,
  isError = false,
  errorMessage,
  extraProperties = {},
} = {}) {
  if (!client) return;
  try {
    client.capture({
      distinctId: distinctId || traceId || "anonymous",
      event: "$ai_generation",
      properties: {
        $ai_provider: provider,
        $ai_model: model,
        $ai_input: clip(input),
        $ai_output: clip(output),
        $ai_input_tokens: inputTokens,
        $ai_output_tokens: outputTokens,
        $ai_latency: typeof latencyMs === "number" ? latencyMs / 1000 : undefined,
        $ai_trace_id: traceId,
        $ai_is_error: isError,
        $ai_error: errorMessage,
        ...extraProperties,
      },
      groups,
    });
  } catch {
    // best-effort
  }
}

export async function shutdownPostHog() {
  if (!client) return;
  try {
    await client.shutdown();
  } catch {
    // best-effort
  }
}
