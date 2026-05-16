import assert from "node:assert/strict";
import {
  buildXPostLookupUrl,
  fetchXPost,
  formatXPostResult,
  getXApiBearerToken,
  normalizeXPostResponse,
  parseXPostId,
} from "../../lib/x-api-client.mjs";

assert.equal(parseXPostId("2055090843845812501"), "2055090843845812501");
assert.equal(parseXPostId("https://x.com/i/status/2055090843845812501"), "2055090843845812501");
assert.equal(parseXPostId("https://x.com/jake/status/2055090843845812501?s=20"), "2055090843845812501");
assert.equal(parseXPostId("https://twitter.com/jake/statuses/2055090843845812501"), "2055090843845812501");
assert.equal(parseXPostId("not-a-post"), "");

assert.equal(getXApiBearerToken({ X_API_BEARER_TOKEN: "x-api" }), "x-api");
assert.equal(getXApiBearerToken({ X_BEARER_TOKEN: "x" }), "x");
assert.equal(getXApiBearerToken({ TWITTER_BEARER_TOKEN: "twitter" }), "twitter");

{
  const lookup = buildXPostLookupUrl("123", { apiBaseUrl: "https://api.example.com/2/" });
  assert.equal(lookup.origin, "https://api.example.com");
  assert.equal(lookup.pathname, "/2/tweets/123");
  assert.match(lookup.searchParams.get("expansions"), /attachments\.media_keys/);
  assert.match(lookup.searchParams.get("media.fields"), /variants/);
}

const raw = {
  data: {
    id: "123",
    text: "watch this",
    author_id: "u1",
    attachments: { media_keys: ["13_abc"] },
    referenced_tweets: [{ type: "quoted", id: "122" }],
  },
  includes: {
    users: [{ id: "u1", username: "covent", name: "Covent", verified: true }],
    tweets: [{ id: "122", text: "quoted post", author_id: "u2" }],
    media: [{
      media_key: "13_abc",
      type: "video",
      preview_image_url: "https://pbs.twimg.com/preview.jpg",
      variants: [
        { content_type: "application/x-mpegURL", url: "https://video.twimg.com/playlist.m3u8" },
        { content_type: "video/mp4", bit_rate: 832000, url: "https://video.twimg.com/low.mp4" },
        { content_type: "video/mp4", bit_rate: 2176000, url: "https://video.twimg.com/high.mp4" },
      ],
    }],
  },
};

{
  const normalized = normalizeXPostResponse(raw, { sourceUrl: "https://x.com/i/status/123", postId: "123" });
  assert.equal(normalized.post.author.username, "covent");
  assert.equal(normalized.media[0].best_video_url, "https://video.twimg.com/high.mp4");
  assert.equal(normalized.media[0].best_video_bit_rate, 2176000);
  assert.equal(normalized.referenced_posts[0].id, "122");
}

{
  let captured;
  const result = await fetchXPost({
    url: "https://x.com/i/status/123",
    bearerToken: "secret-token",
    apiBaseUrl: "https://api.example.com/2",
    fetchFn: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, async json() { return raw; } };
    },
  });
  assert.equal(captured.url.pathname, "/2/tweets/123");
  assert.equal(captured.options.headers.Authorization, "Bearer secret-token");
  assert.equal(result.post.id, "123");
  assert.equal(result.media[0].best_video_url, "https://video.twimg.com/high.mp4");
  assert.doesNotMatch(formatXPostResult(result), /secret-token/);
}

await assert.rejects(
  fetchXPost({ url: "https://x.com/i/status/123", bearerToken: "", fetchFn: async () => ({}) }),
  /X API bearer token is not configured/,
);
await assert.rejects(
  fetchXPost({ url: "https://x.com/nope", bearerToken: "token", fetchFn: async () => ({}) }),
  /Could not parse/,
);

console.log("x-api-client tests passed");
