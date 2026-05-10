const APIFY_API_BASE = "https://api.apify.com/v2";

class ApifyError extends Error {
  constructor(message, { kind, status, retriable } = {}) {
    super(message);
    this.name = "ApifyError";
    this.kind = kind || "apify";
    this.status = status;
    this.retriable = !!retriable;
  }
}

async function postRunSync({ actorId, input, token, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${APIFY_API_BASE}/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") {
      throw new ApifyError(`Apify actor ${actorId} timed out after ${timeoutMs}ms`, { kind: "timeout", retriable: true });
    }
    throw new ApifyError(`Apify network error: ${error.message}`, { kind: "network", retriable: true });
  }
  clearTimeout(timer);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const retriable = response.status >= 500;
    throw new ApifyError(`Apify ${actorId} HTTP ${response.status}: ${body.slice(0, 300)}`, {
      kind: retriable ? "server" : "client",
      status: response.status,
      retriable,
    });
  }

  const json = await response.json().catch(() => null);
  if (!Array.isArray(json)) {
    throw new ApifyError(`Apify ${actorId} returned non-array response`, { kind: "shape", retriable: false });
  }
  return json;
}

export async function runApifyActor({ actorId, input, token, timeoutMs }) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await postRunSync({ actorId, input, token, timeoutMs });
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApifyError) || !error.retriable) throw error;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

function pickFirstString(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

function joinTranscriptSegments(items) {
  if (!Array.isArray(items)) return "";
  const lines = [];
  for (const item of items) {
    if (typeof item === "string") {
      lines.push(item);
    } else if (item && typeof item === "object") {
      const text = pickFirstString(item.text, item.segment, item.line, item.content);
      if (text) lines.push(text);
    }
  }
  return lines.join("\n").trim();
}

export async function fetchYouTubeTranscript(url, { token, actorId, timeoutMs }) {
  const items = await runApifyActor({
    actorId,
    token,
    timeoutMs,
    input: { videoUrl: url, video_url: url, urls: [url], includeMetadata: true },
  });
  if (items.length === 0) {
    throw new ApifyError("No transcript items returned", { kind: "empty", retriable: false });
  }
  const first = items[0] || {};
  const transcript = pickFirstString(
    first.transcript,
    first.transcriptText,
    first.full_text,
    first.text,
    joinTranscriptSegments(first.transcript_segments || first.segments || first.captions || items),
  );
  if (!transcript) {
    throw new ApifyError("Transcript field empty in actor response", { kind: "empty", retriable: false });
  }
  return {
    transcript,
    metadata: {
      title: pickFirstString(first.title, first.videoTitle),
      author: pickFirstString(first.channelName, first.author, first.channel),
      durationSec: typeof first.durationSec === "number" ? first.durationSec : undefined,
      publishedAt: pickFirstString(first.publishedAt, first.publishDate, first.uploadDate),
      sourceUrl: url,
    },
  };
}

export async function fetchTwitterTranscript(url, { token, actorId, timeoutMs }) {
  const items = await runApifyActor({
    actorId,
    token,
    timeoutMs,
    input: { startUrls: [{ url }], tweetUrls: [url], maxItems: 1 },
  });
  if (items.length === 0) {
    throw new ApifyError("No tweets returned", { kind: "empty", retriable: false });
  }
  const tweet = items[0] || {};
  const transcript = pickFirstString(tweet.full_text, tweet.text, tweet.fullText, tweet.content);
  if (!transcript) {
    throw new ApifyError("Tweet text missing in actor response", { kind: "empty", retriable: false });
  }
  const author = tweet.user || tweet.author || {};
  return {
    transcript,
    metadata: {
      title: `Tweet by @${pickFirstString(author.username, author.screen_name, author.handle, "unknown")}`,
      author: pickFirstString(author.name, author.username, author.screen_name),
      publishedAt: pickFirstString(tweet.createdAt, tweet.created_at, tweet.date),
      sourceUrl: url,
    },
  };
}

export async function fetchSpotifyTranscript(url, { token, actorId, timeoutMs }) {
  const items = await runApifyActor({
    actorId,
    token,
    timeoutMs,
    input: { startUrls: [{ url }], episodeUrls: [url], urls: [url] },
  });
  if (items.length === 0) {
    throw new ApifyError("No Spotify items returned", { kind: "empty", retriable: false });
  }
  const item = items[0] || {};
  const transcript = pickFirstString(
    item.transcript,
    item.transcriptText,
    item.full_text,
    joinTranscriptSegments(item.transcript_segments || item.segments),
  );
  const description = pickFirstString(item.description, item.summary, item.episodeDescription);
  const fallback = !transcript && description ? `[Transcript unavailable — episode description follows]\n\n${description}` : "";
  const finalTranscript = transcript || fallback;
  if (!finalTranscript) {
    throw new ApifyError("No transcript or description available for Spotify item", { kind: "empty", retriable: false });
  }
  return {
    transcript: finalTranscript,
    metadata: {
      title: pickFirstString(item.title, item.episodeName, item.name),
      author: pickFirstString(item.show, item.showName, item.podcast, item.author),
      durationSec: typeof item.durationSec === "number" ? item.durationSec : undefined,
      publishedAt: pickFirstString(item.releaseDate, item.publishedAt, item.date),
      sourceUrl: url,
      transcriptFallbackUsed: !transcript,
    },
  };
}

export async function fetchTranscriptForKind({ kind, url, config }) {
  const common = {
    token: config.apifyToken,
    timeoutMs: config.perLinkTimeoutMs,
  };
  switch (kind) {
    case "youtube":
      return fetchYouTubeTranscript(url, { ...common, actorId: config.actors.youtube });
    case "twitter":
      return fetchTwitterTranscript(url, { ...common, actorId: config.actors.twitter });
    case "spotify":
      return fetchSpotifyTranscript(url, { ...common, actorId: config.actors.spotify });
    default:
      throw new ApifyError(`Unsupported insights kind: ${kind}`, { kind: "unsupported", retriable: false });
  }
}

export { ApifyError };
