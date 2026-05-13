// Pi custom tool: `read_image_content`.
//
// The default prompt-assembly pipeline (apps/pi-mom/lib/thread-context.mjs)
// inlines a Gemini-generated *textual* description of every Slack-attached
// image so the agent can reason over visual content without consuming
// multimodal tokens. That covers ~95% of cases. When the description is
// not enough — e.g. the model needs to verify exact pixel-level text, or
// the description missed a detail the user is asking about — this tool
// lets the model fetch the raw image and hand it back to itself as a
// vision tool result.
//
// Mirrors the canonical defensive pattern from
//   `packages/coding-agent/src/core/tools/read.ts`
// in the Pi SDK (installed at
//   node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js):
//   - guard `ctx.model.input.includes("image")` before returning an image
//     block; if the active model isn't vision-capable, return text-only
//     with an explicit "model does not support image input" note instead
//     of silently failing.
//   - resize before base64-encoding to stay inside per-provider per-image
//     token budgets. Resize is *optional* and injected at construction
//     time so this file stays free of native deps (sharp/photon); if
//     resize is unavailable or throws, we fall through with raw bytes
//     and rely on provider-side downscaling.
//
// Slack I/O is delegated to the Phase 1 helpers in
//   apps/pi-mom/lib/slack-thread-fetcher.mjs (`hydrateFiles` +
//   `downloadFileBytes`) so this tool stays a thin composition layer.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// @ts-ignore - .mjs JS module without its own .d.ts; we treat its surface as `any`.
import { hydrateFiles, downloadFileBytes } from "../apps/pi-mom/lib/slack-thread-fetcher.mjs";

type ResultContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface ToolResult {
  content: ResultContent[];
  details?: any;
  isError?: boolean;
}

export interface ImageReaderOptions {
  /** Slack `WebClient` instance. Injected by `pi-sdk-runner` at runtime. */
  slackClient?: any;
  /** Slack bot token, used for the raw `Authorization: Bearer …` download. */
  botToken?: string;
  /**
   * Optional resize hook. If provided, called with the downloaded bytes;
   * if it throws or returns falsy, we fall back to the raw buffer. Keeping
   * this optional means the extension has zero native-binary dependency
   * at registration time — important because `pi-sdk-runner` instantiates
   * the default factory at module load.
   */
  resizeImage?: (
    buf: Buffer,
    mimeType: string,
  ) => Promise<{ buffer: Buffer; mimeType: string; width?: number; height?: number; resized?: boolean } | null | undefined>;
  /** Hook for tests / pluggable logging. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

function textOnly(text: string, isError: boolean, details?: any): ToolResult {
  return { content: [{ type: "text", text }], details, isError };
}

let _resizeWarnEmitted = false;

export function createImageReaderFactory({
  slackClient,
  botToken,
  resizeImage,
  warn = (m: string) => console.warn(m),
}: ImageReaderOptions = {}) {
  return function imageReader(pi: ExtensionAPI) {
    pi.registerTool({
      name: "read_image_content",
      label: "Read Slack image natively",
      description:
        "Fetch a Slack-attached image by file_id and hand it to the agent as a visual tool result. Use this when the inline AI-generated description in the thread context is not enough — e.g. you need to verify text or details the description missed. Returns a vision content block the agent can see directly.",
      promptSnippet:
        "read_image_content: visually inspect a Slack-attached image by file_id when the description is insufficient.",
      promptGuidelines: [
        "Call this only when the inline image description doesn't answer the question.",
        "Pass the file_id from the thread's [image#FXXXXX ...] block, not a URL.",
        "Do not call more than 3 times per turn.",
      ],
      parameters: Type.Object({
        file_id: Type.String({
          minLength: 1,
          description:
            "Slack file_id (e.g. F0123ABCD) from the thread context attachment list.",
        }),
      }),
      async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
        // 0. Pre-abort — if the agent was already aborted, bail out
        // without touching the network. The Phase 1 helpers don't accept
        // an external signal, so we check it manually at the boundaries.
        if (signal?.aborted) {
          return textOnly("read_image_content: aborted", true);
        }

        // 1. Param validation. We rely on TypeBox at the contract layer,
        // but defend at runtime too — the SDK may relax validation per
        // provider, and the cost of a stray invalid call is misleading
        // error chatter for the user.
        const fileId =
          typeof params?.file_id === "string" ? params.file_id.trim() : "";
        if (!fileId) {
          return textOnly("read_image_content: file_id is required", true);
        }

        // 2. Resolve the Slack file via the Phase 1 hydrator. We pass a
        // single-element array because `hydrateFiles` is the canonical
        // entry point that wraps `files.info` in a deadline + stub-on-
        // failure shape. If the underlying call errored, the helper
        // returns a stub `{ id, name, mimetype, error }`.
        if (!slackClient) {
          return textOnly(
            "read_image_content: Slack client not configured in bot runtime",
            true,
          );
        }
        let entry: any;
        try {
          const hydrated = await hydrateFiles({
            client: slackClient,
            files: [{ id: fileId }],
            deadlineMs: 3000,
          });
          entry = Array.isArray(hydrated) ? hydrated[0] : undefined;
        } catch (err: any) {
          return textOnly(
            `read_image_content: file lookup failed: ${err?.message || String(err)}`,
            true,
          );
        }
        if (signal?.aborted) {
          return textOnly("read_image_content: aborted", true);
        }
        if (!entry || entry.error) {
          return textOnly(
            `read_image_content: file lookup failed: ${entry?.error || "no file returned"}`,
            true,
          );
        }

        // 3. Mime-type check. If the file isn't an image we don't want
        // to silently hand the agent something it can't render.
        const mimeType: string =
          typeof entry.mimetype === "string" ? entry.mimetype : "";
        if (!mimeType.startsWith("image/")) {
          return textOnly(
            `read_image_content: file ${fileId} is not an image (mimetype=${mimeType || "unknown"})`,
            true,
          );
        }

        // 4. Download bytes via the Phase 1 helper. It rejects text/html
        // responses as `auth_failure`, so we propagate that distinction
        // back to the agent verbatim.
        const url: string =
          typeof entry.url_private === "string" ? entry.url_private : "";
        if (!url) {
          return textOnly(
            `read_image_content: file ${fileId} has no url_private (cannot download)`,
            true,
          );
        }
        if (!botToken) {
          return textOnly(
            "read_image_content: SLACK_BOT_TOKEN not configured in bot environment",
            true,
          );
        }
        const dl: any = await downloadFileBytes({
          url,
          botToken,
          deadlineMs: 5000,
        });
        if (signal?.aborted) {
          return textOnly("read_image_content: aborted", true);
        }
        if (!dl || dl.error || !dl.buffer) {
          return textOnly(
            `read_image_content: download failed: ${dl?.error || "no bytes"}`,
            true,
          );
        }

        // 5. Resize (best-effort). If the caller didn't inject a resize
        // implementation, or it throws, we fall back to raw bytes — the
        // provider's own downscaler is the last line of defense. We
        // only emit the "resize unavailable" warning once per process to
        // avoid log spam on busy threads.
        let buffer: Buffer = dl.buffer;
        let finalMime: string = mimeType;
        let width: number | undefined;
        let height: number | undefined;
        let resized = false;
        if (typeof resizeImage === "function") {
          try {
            const r = await resizeImage(dl.buffer, mimeType);
            if (r && r.buffer) {
              buffer = r.buffer;
              if (r.mimeType) finalMime = r.mimeType;
              width = r.width;
              height = r.height;
              resized = r.resized !== false;
            }
          } catch (err: any) {
            warn(
              `read_image_content: resize failed (${err?.message || String(err)}); using raw bytes`,
            );
          }
        } else if (!_resizeWarnEmitted) {
          _resizeWarnEmitted = true;
          warn(
            "read_image_content: no resize implementation injected; falling through with raw bytes",
          );
        }

        // 6. Defensive vision-capability guard (mirrors `read.ts`). The
        // active model is on `ctx.model` per the SDK's ExtensionContext.
        // If the model can't accept image input we return a text-only
        // descriptor instead of a multimodal block so the request still
        // reaches the provider intact. This is `isError: false` because
        // it is a controlled fallback, not a tool failure.
        const filename: string = entry.name || `${fileId}`;
        const permalink: string =
          (typeof entry.permalink === "string" && entry.permalink) ||
          (typeof entry.permalink_public === "string" && entry.permalink_public) ||
          url;
        const model: any = (ctx as any)?.model;
        const modelInput: any = model?.input;
        const supportsImage = Array.isArray(modelInput)
          ? modelInput.includes("image")
          : false;
        if (model && !supportsImage) {
          return textOnly(
            `[Current model does not support image input. Image was not returned. file_id=${fileId}, name=${filename}, url=${permalink}]`,
            false,
            { fileId, sizeBytes: buffer.length, resized, modelNotVisionCapable: true },
          );
        }

        // 7. Native vision return. We follow read.ts shape:
        //   - first content block: text descriptor (filename, dims, URL)
        //   - second content block: image with raw base64 (no data: URI
        //     prefix — the Pi SDK normalizes that across providers).
        const dimsPart = width && height ? `${width}x${height} px · ` : "";
        const captionText = `Image: ${filename} · ${dimsPart}${permalink}`;
        const base64 = buffer.toString("base64");
        return {
          content: [
            { type: "text", text: captionText },
            { type: "image", data: base64, mimeType: finalMime },
          ],
          details: { fileId, sizeBytes: buffer.length, resized },
          isError: false,
        };
      },
    });
  };
}

// Default export uses no Slack client / no resize. `pi-sdk-runner.mjs`
// can drop this straight into `extensionFactories` like permission-gate
// and linear-tools; the existing pi-sdk-runner unit tests construct the
// runner with a stubbed `buildResourceLoader` so the factories list is
// never actually iterated, which lets us defer real Slack-client wiring
// to Phase 4 (Worker F) without breaking those tests today.
const defaultFactory = createImageReaderFactory({
  botToken: process.env.SLACK_BOT_TOKEN,
});
export default defaultFactory;
