import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchXPost, formatXPostResult } from "../lib/x-api-client.mjs";

export default function xFetchPostTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "x_fetch_post",
    label: "Fetch X post",
    description:
      "Fetch a public X/Twitter post via the official X API v2 Post lookup endpoint, including author metadata, referenced posts, and attached media/video variants. Reads X_API_BEARER_TOKEN from the runtime environment; never ask users to paste tokens.",
    promptSnippet:
      "x_fetch_post: use the official X API for public X post/video URLs before browser/cookie/unofficial fetch fallbacks.",
    promptGuidelines: [
      "Use x_fetch_post when the user asks to fetch, summarize, or analyze a public X/Twitter post URL.",
      "Prefer this official API path before Browser Use, Apify, Bird, cookies, or scraping for normal public posts.",
      "Never request, print, or log X API bearer tokens. The tool reads X_API_BEARER_TOKEN/X_BEARER_TOKEN/TWITTER_BEARER_TOKEN from the environment only.",
      "If the tool reports auth, rate-limit, unavailable, or protected-post errors, explain that a browser/unofficial fallback may still be needed.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Full X/Twitter post URL, e.g. https://x.com/user/status/123 or https://x.com/i/status/123." })),
      post_id: Type.Optional(Type.String({ description: "X post ID. Use when the ID is already known instead of a URL." })),
      include_raw: Type.Optional(Type.Boolean({ description: "Include the raw X API JSON in the text result. Defaults to false." })),
    }),
    async execute(_toolCallId, params: any, signal) {
      try {
        const result = await fetchXPost({
          url: params.url,
          postId: params.post_id,
          signal,
        } as any);
        const includeRaw = params.include_raw === true;
        return {
          content: [{ type: "text", text: formatXPostResult(result, { includeRaw }) }],
          details: includeRaw ? result : { ...result, raw: undefined },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `x_fetch_post failed: ${err?.message || String(err)}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
}
