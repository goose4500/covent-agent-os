function boundedIntegerEnv(name, fallback, { min, max }) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseExtraArgs(value) {
  return (value || "").split(/\s+/).filter(Boolean);
}

const enabled = process.env.INSIGHTS_FEATURE_ENABLED === "true";

export const INSIGHTS_CONFIG = Object.freeze({
  enabled,
  channelId: process.env.INSIGHTS_CHANNEL_ID || "",
  apifyToken: process.env.APIFY_API_TOKEN || "",
  actors: Object.freeze({
    twitter: process.env.INSIGHTS_APIFY_ACTOR_TWITTER || "apidojo~twitter-scraper-lite",
    youtube: process.env.INSIGHTS_APIFY_ACTOR_YOUTUBE || "pintostudio~youtube-transcript-scraper",
    spotify: process.env.INSIGHTS_APIFY_ACTOR_SPOTIFY || "pintostudio~spotify-scraper",
  }),
  maxTranscriptChars: boundedIntegerEnv("INSIGHTS_TRANSCRIPT_MAX_CHARS", 60000, { min: 1000, max: 500000 }),
  perLinkTimeoutMs: boundedIntegerEnv("INSIGHTS_PER_LINK_TIMEOUT_MS", 90000, { min: 5000, max: 600000 }),
  dedupeTtlMs: boundedIntegerEnv("INSIGHTS_DEDUPE_TTL_MS", 60 * 60 * 1000, { min: 60_000, max: 24 * 60 * 60 * 1000 }),
  piExtraArgs: parseExtraArgs(process.env.INSIGHTS_PI_EXTRA_ARGS),
  dryRun: process.env.INSIGHTS_DRY_RUN === "true",
});

export function logInsightsStartup() {
  if (!INSIGHTS_CONFIG.enabled) {
    console.log("Insights route: disabled (set INSIGHTS_FEATURE_ENABLED=true to enable)");
    return;
  }
  const missing = [];
  if (!INSIGHTS_CONFIG.channelId) missing.push("INSIGHTS_CHANNEL_ID");
  if (!INSIGHTS_CONFIG.apifyToken) missing.push("APIFY_API_TOKEN");
  if (missing.length > 0) {
    console.warn(`Insights route: enabled but missing ${missing.join(", ")} — handler will report misconfiguration on first message.`);
    return;
  }
  console.log(`Insights route: enabled on channel ${INSIGHTS_CONFIG.channelId} (dryRun=${INSIGHTS_CONFIG.dryRun})`);
}

export function insightsMisconfiguration() {
  if (!INSIGHTS_CONFIG.enabled) return "INSIGHTS_FEATURE_ENABLED must be true";
  if (!INSIGHTS_CONFIG.channelId) return "INSIGHTS_CHANNEL_ID is not set";
  if (!INSIGHTS_CONFIG.apifyToken) return "APIFY_API_TOKEN is not set";
  return null;
}
