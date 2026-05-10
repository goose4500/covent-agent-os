import { createReadStream } from "node:fs";
import { bufferToDataUrl, detectImageMime } from "../openai-image-client.mjs";
import { slackFileLooksLikeImage, slackImageMime } from "../domain/slack-format.mjs";

export function createSlackAdapter({ config, trace, getAuthTeamId }) {
  async function getThreadMessages(client, channel, rootTs) {
    const res = await client.conversations.replies({ channel, ts: rootTs, limit: 12 });
    return res.messages || [];
  }

  async function getThreadContext(client, channel, rootTs) {
    try {
      const messages = await getThreadMessages(client, channel, rootTs);
      return messages
        .map((m) => `${m.user ? `<@${m.user}>` : m.username || "unknown"} [${m.ts}]: ${m.text || ""}`)
        .join("\n");
    } catch (error) {
      return `Thread context unavailable from Slack Web API: ${error?.data?.error || error.message}`;
    }
  }

  async function getSlackPermalink(client, channel, messageTs) {
    try {
      const response = await client.chat.getPermalink({ channel, message_ts: messageTs });
      return response.ok ? response.permalink : "";
    } catch (error) {
      trace("slack.permalink_failed", { error: error?.data?.error || error.message });
      return "";
    }
  }

  function streamArgsForEvent({ channel, threadTs, user, team }) {
    const teamId = team || getAuthTeamId();
    const args = { channel, thread_ts: threadTs, buffer_size: config.pi.streamBufferChars };
    if (user && teamId) {
      args.recipient_user_id = user;
      args.recipient_team_id = teamId;
    }
    return args;
  }

  async function slackFileToImageInput(file) {
    const url = file.url_private_download || file.url_private;
    if (!url) return undefined;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.slack.botToken}` },
    });
    if (!response.ok) {
      throw new Error(`Could not download Slack image ${file.id || file.name || "unknown"}: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > config.image.maxBytes) {
      throw new Error(`Slack image ${file.name || file.id || "unknown"} is too large for MVP (${buffer.length} bytes > ${config.image.maxBytes}).`);
    }

    const detectedMime = detectImageMime(buffer);
    if (!detectedMime) {
      throw new Error(`Slack file ${file.name || file.id || "unknown"} is not a supported PNG, JPEG, or WebP image.`);
    }

    const mimeType = detectedMime || (response.headers.get("content-type") || slackImageMime(file)).split(";")[0].trim();
    return {
      imageUrl: bufferToDataUrl(buffer, mimeType),
      name: file.name || file.title || file.id || "slack-image",
      id: file.id,
      mimeType,
      bytes: buffer.length,
    };
  }

  async function collectSlackImageInputs(client, event, channel, threadTs) {
    const messages = await getThreadMessages(client, channel, threadTs);
    const filesByKey = new Map();

    for (const file of event.files || []) {
      if (slackFileLooksLikeImage(file)) filesByKey.set(file.id || file.url_private || file.name, file);
    }

    for (const message of messages) {
      for (const file of message.files || []) {
        if (slackFileLooksLikeImage(file)) filesByKey.set(file.id || file.url_private || file.name, file);
      }
    }

    const selectedFiles = [...filesByKey.values()].slice(0, config.image.maxInputs);
    const inputs = [];
    for (const file of selectedFiles) {
      const input = await slackFileToImageInput(file);
      if (input) inputs.push(input);
    }

    return {
      inputs,
      totalImageFiles: filesByKey.size,
      usedImageFiles: inputs.length,
      skippedImageFiles: Math.max(0, filesByKey.size - inputs.length),
    };
  }

  async function uploadImageResultToSlack(client, channel, threadTs, result, requestId, comment) {
    let uploaded = 0;
    for (const file of result.files) {
      await client.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: createReadStream(file.path),
        filename: file.filename,
        title: file.filename,
        initial_comment: uploaded === 0 ? comment : undefined,
      });
      uploaded += 1;
    }
    trace("slack.uploaded_image", { requestId, uploaded, files: result.files.length });
    return uploaded;
  }

  return {
    getThreadMessages,
    getThreadContext,
    getSlackPermalink,
    streamArgsForEvent,
    slackFileToImageInput,
    collectSlackImageInputs,
    uploadImageResultToSlack,
  };
}
