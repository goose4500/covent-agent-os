import { createOpenAIImage } from "../openai-image-client.ts";
import { parseImageRequest } from "../domain/commands.ts";
import { redactSensitiveText } from "../domain/redact.ts";
import { truncateForSlack } from "../domain/slack-format.ts";
import type { Config } from "../config.ts";
import type { Trace } from "../trace.ts";
import type { createSlackAdapter } from "../adapters/slack.ts";

export type ImageRouteDeps = {
  config: Config;
  trace: Trace;
  slack: ReturnType<typeof createSlackAdapter>;
};

function formatImageSlackComment(result: any, { prompt, inputCount, maxTextChars }: { prompt: string; inputCount: number; maxTextChars: number }) {
  const actionLabel = result.action === "edit" ? "edited/reference image" : "generated image";
  const safePrompt = truncateForSlack(prompt, maxTextChars).slice(0, 1200);
  const localFiles = result.files.map((file) => `• ${file.filename}`).join("\n");
  const metadataName = result.metadataPath.split("/").pop();

  return `🎨 *Covent Pi ${actionLabel}*\n` +
    `• model: \`${result.model}\`\n` +
    `• quality/size: \`${result.options.quality}\` / \`${result.options.size}\`\n` +
    `• input images: \`${inputCount}\`\n` +
    (result.requestId ? `• request: \`${result.requestId}\`\n` : "") +
    `• metadata: \`${metadataName}\`\n\n` +
    `*Prompt*\n${safePrompt}\n\n` +
    `*Saved locally*\n${localFiles}`;
}

export function createImageRoute({ config, trace, slack }: ImageRouteDeps) {
  return async function imageHandle({ client, event, channel, threadTs, user, text, requestId, start }: {
    client: any;
    event: any;
    channel: string;
    threadTs: string;
    user: string;
    text: string;
    requestId: string;
    start: number;
  }) {
    if (!config.image.routeEnabled) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "The `image:` route is disabled. Set `PI_MOM_IMAGE_ROUTE_ENABLED=true` and restart pi-mom to enable it.",
      });
      trace("slack.replied_image_disabled", { requestId, durationMs: Date.now() - start });
      return;
    }

    const { prompt, requestedAction } = parseImageRequest(text);
    if (!prompt) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "Usage: `@Covent Pi image: create ...` or attach an image and use `@Covent Pi image: edit ...`.",
      });
      trace("slack.replied_image_usage", { requestId, durationMs: Date.now() - start });
      return;
    }

    if (!config.image.apiKey) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "The `image:` route needs `OPENAI_API_KEY` in the pi-mom environment. I did not call OpenAI.",
      });
      trace("slack.replied_image_missing_key", { requestId, durationMs: Date.now() - start });
      return;
    }

    const thinking = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `🎨 Covent Pi is preparing an image request… (req: ${requestId})`,
    });

    try {
      const action = requestedAction || "generate";
      const collected = action === "edit"
        ? await slack.collectSlackImageInputs(client, event, channel, threadTs)
        : { inputs: [], totalImageFiles: 0, usedImageFiles: 0, skippedImageFiles: 0 };

      if (action === "edit" && collected.inputs.length === 0) {
        await client.chat.update({
          channel,
          ts: thinking.ts,
          text: "For `image: edit`, attach an image in this thread or use `image: generate` for text-only generation.",
        });
        trace("slack.replied_image_missing_input", { requestId, durationMs: Date.now() - start });
        return;
      }

      trace("openai.image_request", {
        requestId,
        action,
        model: config.image.model,
        quality: config.image.quality,
        size: config.image.size,
        inputImages: collected.inputs.length,
        skippedImages: collected.skippedImageFiles,
      });

      const result = await createOpenAIImage({
        action,
        prompt,
        imageDataUrls: collected.inputs.map((input) => input.imageUrl),
        model: config.image.model,
        size: config.image.size,
        quality: config.image.quality,
        outputFormat: config.image.outputFormat,
        background: config.image.background,
        outputDir: config.image.outputDir,
        prefix: `slack-${requestId}`,
        user: user ? `slack:${user}` : undefined,
      });

      const comment = formatImageSlackComment(result, {
        prompt,
        inputCount: collected.inputs.length,
        maxTextChars: config.slack.maxTextChars,
      });
      const uploaded = await slack.uploadImageResultToSlack(client, channel, threadTs, result, requestId, comment);

      await client.chat.update({
        channel,
        ts: thinking.ts,
        text: `✅ Uploaded ${uploaded} image file(s). Model: \`${result.model}\`. Metadata: \`${result.metadataPath.split("/").pop()}\``,
      });
      trace("slack.replied_image", { requestId, durationMs: Date.now() - start, resultLength: comment.length, uploaded });
    } catch (error) {
      const message = redactSensitiveText(error?.message || String(error)).slice(0, 1500);
      trace("error", { requestId, route: "image", error: message, durationMs: Date.now() - start });
      console.error(`[pi-mom] ${requestId} image error:`, error);
      await client.chat.update({
        channel,
        ts: thinking.ts,
        text: `Image generation failed (req: ${requestId}). Check the pi-mom terminal/logs for details.`,
      });
    }
  };
}
