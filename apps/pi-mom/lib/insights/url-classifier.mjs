import { createHash } from "node:crypto";

const TWITTER_HOSTS = new Set(["twitter.com", "www.twitter.com", "x.com", "www.x.com", "mobile.twitter.com"]);
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const SPOTIFY_HOSTS = new Set(["open.spotify.com", "spotify.com", "www.spotify.com"]);

function unwrapSlackTokens(text) {
  if (!text) return [];
  const out = [];
  const re = /<([^<>|]+)(?:\|[^<>]*)?>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function extractBareUrls(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s<>"'`|]+/gi;
  return text.match(re) || [];
}

function safeParse(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function classifyHost(host) {
  const h = host.toLowerCase();
  if (TWITTER_HOSTS.has(h)) return "twitter";
  if (YOUTUBE_HOSTS.has(h)) return "youtube";
  if (SPOTIFY_HOSTS.has(h)) return "spotify";
  return "unsupported";
}

function normalizeYouTube(url) {
  if (url.hostname === "youtu.be") {
    const id = url.pathname.replace(/^\//, "").split("/")[0];
    if (!id) return null;
    return `https://www.youtube.com/watch?v=${id}`;
  }
  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v");
    if (!id) return null;
    return `https://www.youtube.com/watch?v=${id}`;
  }
  if (url.pathname.startsWith("/shorts/")) {
    const id = url.pathname.split("/")[2];
    if (!id) return null;
    return `https://www.youtube.com/watch?v=${id}`;
  }
  if (url.pathname.startsWith("/live/")) {
    const id = url.pathname.split("/")[2];
    if (!id) return null;
    return `https://www.youtube.com/watch?v=${id}`;
  }
  return null;
}

function normalizeTwitter(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[1] !== "status") return null;
  const user = parts[0];
  const id = parts[2].split("?")[0];
  if (!user || !/^\d+$/.test(id)) return null;
  return `https://x.com/${user}/status/${id}`;
}

function normalizeSpotify(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const kind = parts[0];
  const id = parts[1];
  if (kind !== "episode" && kind !== "show") return null;
  if (!/^[A-Za-z0-9]+$/.test(id)) return null;
  return `https://open.spotify.com/${kind}/${id}`;
}

function normalize(url, kind) {
  switch (kind) {
    case "youtube": return normalizeYouTube(url);
    case "twitter": return normalizeTwitter(url);
    case "spotify": return normalizeSpotify(url);
    default: return null;
  }
}

function hashUrl(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function extractSupportedUrls(slackText) {
  const candidates = new Set([
    ...unwrapSlackTokens(slackText),
    ...extractBareUrls(slackText),
  ]);

  const seen = new Set();
  const results = [];
  for (const raw of candidates) {
    const cleaned = raw.replace(/[)>\].,;!?]+$/g, "");
    const parsed = safeParse(cleaned);
    if (!parsed) continue;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const kind = classifyHost(parsed.hostname);
    if (kind === "unsupported") continue;
    const normalizedUrl = normalize(parsed, kind);
    if (!normalizedUrl) continue;
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    results.push({
      raw,
      url: cleaned,
      kind,
      normalizedUrl,
      hash: hashUrl(normalizedUrl),
    });
  }
  return results;
}
