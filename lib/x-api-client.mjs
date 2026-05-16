const DEFAULT_X_API_BASE_URL = "https://api.x.com/2";
const DEFAULT_EXPANSIONS = [
  "author_id",
  "attachments.media_keys",
  "referenced_tweets.id",
  "referenced_tweets.id.author_id",
];
const DEFAULT_TWEET_FIELDS = [
  "attachments",
  "author_id",
  "conversation_id",
  "created_at",
  "entities",
  "public_metrics",
  "referenced_tweets",
];
const DEFAULT_USER_FIELDS = ["id", "name", "username", "verified", "profile_image_url"];
const DEFAULT_MEDIA_FIELDS = [
  "alt_text",
  "duration_ms",
  "height",
  "media_key",
  "preview_image_url",
  "type",
  "url",
  "variants",
  "width",
];

export function getXApiBearerToken(env = process.env) {
  return env.X_API_BEARER_TOKEN || env.X_BEARER_TOKEN || env.TWITTER_BEARER_TOKEN || "";
}

export function parseXPostId(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  if (/^\d{5,}$/.test(value)) return value;

  const candidate = value.match(/(?:x|twitter)\.com\/(?:i\/web\/)?(?:[^\s/?#]+\/)?status(?:es)?\/(\d+)/i)
    || value.match(/(?:x|twitter)\.com\/i\/status\/(\d+)/i)
    || value.match(/[?&]tweet_id=(\d+)/i);
  if (candidate?.[1]) return candidate[1];

  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const statusIndex = parts.findIndex((part) => part === "status" || part === "statuses");
    if (statusIndex >= 0 && /^\d+$/.test(parts[statusIndex + 1] || "")) {
      return parts[statusIndex + 1];
    }
    if (parts[0] === "i" && parts[1] === "status" && /^\d+$/.test(parts[2] || "")) {
      return parts[2];
    }
  } catch {}
  return "";
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_X_API_BASE_URL).replace(/\/+$/, "");
}

export function buildXPostLookupUrl(postId, { apiBaseUrl = DEFAULT_X_API_BASE_URL } = {}) {
  const url = new URL(`${normalizeBaseUrl(apiBaseUrl)}/tweets/${encodeURIComponent(postId)}`);
  url.searchParams.set("expansions", DEFAULT_EXPANSIONS.join(","));
  url.searchParams.set("tweet.fields", DEFAULT_TWEET_FIELDS.join(","));
  url.searchParams.set("user.fields", DEFAULT_USER_FIELDS.join(","));
  url.searchParams.set("media.fields", DEFAULT_MEDIA_FIELDS.join(","));
  return url;
}

function chooseBestVideoVariant(variants = []) {
  if (!Array.isArray(variants)) return null;
  const mp4 = variants
    .filter((variant) => variant?.url && variant?.content_type === "video/mp4")
    .sort((a, b) => Number(b.bit_rate || 0) - Number(a.bit_rate || 0));
  return mp4[0] || variants.find((variant) => variant?.url && variant?.content_type === "application/x-mpegURL") || variants.find((variant) => variant?.url) || null;
}

function normalizeMedia(media = []) {
  if (!Array.isArray(media)) return [];
  return media.map((item) => {
    const best = chooseBestVideoVariant(item.variants);
    return {
      media_key: item.media_key,
      type: item.type,
      url: item.url,
      preview_image_url: item.preview_image_url,
      alt_text: item.alt_text,
      duration_ms: item.duration_ms,
      width: item.width,
      height: item.height,
      best_video_url: best?.url,
      best_video_content_type: best?.content_type,
      best_video_bit_rate: best?.bit_rate,
      variants: Array.isArray(item.variants) ? item.variants : undefined,
    };
  });
}

function normalizeReferencedPosts(posts = [], usersById = new Map()) {
  if (!Array.isArray(posts)) return [];
  return posts.map((post) => ({
    id: post.id,
    text: post.text,
    author_id: post.author_id,
    author: usersById.get(post.author_id),
    created_at: post.created_at,
    public_metrics: post.public_metrics,
  }));
}

export function normalizeXPostResponse(raw, { sourceUrl, postId } = {}) {
  const users = raw?.includes?.users || [];
  const usersById = new Map(users.map((user) => [user.id, user]));
  const post = raw?.data || null;
  return {
    post: post ? {
      id: post.id || postId,
      text: post.text,
      url: sourceUrl || (post.id ? `https://x.com/i/status/${post.id}` : undefined),
      author_id: post.author_id,
      author: usersById.get(post.author_id),
      created_at: post.created_at,
      conversation_id: post.conversation_id,
      public_metrics: post.public_metrics,
      referenced_tweets: post.referenced_tweets,
      attachments: post.attachments,
    } : null,
    media: normalizeMedia(raw?.includes?.media),
    referenced_posts: normalizeReferencedPosts(raw?.includes?.tweets, usersById),
    errors: raw?.errors,
  };
}

export async function fetchXPost({
  url,
  postId,
  bearerToken = getXApiBearerToken(),
  apiBaseUrl = DEFAULT_X_API_BASE_URL,
  fetchFn = globalThis.fetch,
  signal,
} = {}) {
  const id = postId || parseXPostId(url);
  if (!id) throw new Error("Could not parse an X post ID from the provided URL/id.");
  if (!bearerToken) throw new Error("X API bearer token is not configured. Set X_API_BEARER_TOKEN in the runtime environment.");
  if (typeof fetchFn !== "function") throw new Error("fetch is not available in this runtime.");

  const endpoint = buildXPostLookupUrl(id, { apiBaseUrl });
  const response = await fetchFn(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: "application/json",
    },
    signal,
  });

  let raw;
  try {
    raw = await response.json();
  } catch {
    raw = null;
  }

  if (!response.ok) {
    const detail = raw?.detail || raw?.title || raw?.errors?.[0]?.detail || raw?.errors?.[0]?.title || response.statusText;
    throw new Error(`X API request failed (${response.status}): ${detail}`);
  }

  return {
    id,
    request_url: endpoint.toString(),
    ...normalizeXPostResponse(raw, { sourceUrl: url, postId: id }),
    raw,
  };
}

export function formatXPostResult(result, { includeRaw = false } = {}) {
  const author = result?.post?.author;
  const handle = author?.username ? `@${author.username}` : result?.post?.author_id || "unknown author";
  return [
    `Fetched X post ${result?.post?.id || result?.id} by ${handle}.`,
    "",
    JSON.stringify({
      post: result.post,
      media: result.media,
      referenced_posts: result.referenced_posts,
      errors: result.errors,
      raw: includeRaw ? result.raw : undefined,
    }, null, 2),
  ].join("\n");
}
