import { App, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bufferToDataUrl, createOpenAIImage, detectImageMime } from "./lib/openai-image-client.mjs";
import { loadConfig } from "./lib/config.mjs";
import {
  parseImageRequest,
  parseSlackRequestCommand,
  parseSlackThreadReference,
  stripBotMentions,
} from "./lib/domain/commands.mjs";
import { ROUTES } from "./lib/domain/routes.mjs";
import { cleanPiOutput, redactSensitiveText, stripTerminalSequences } from "./lib/domain/redact.mjs";
import {
  formatHelp,
  slackFileLooksLikeImage,
  slackImageMime,
  splitForSlackStream,
  truncateForSlack,
} from "./lib/domain/slack-format.mjs";
import { clampLinearTitle, extractLinearIssuePayload } from "./lib/domain/linear-payload.mjs";
import { buildPiPrompt } from "./lib/domain/prompt.mjs";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// Runtime values discovered after startup (e.g. the Slack team ID from auth.test).
// Lives in a single named object instead of free module-level `let` bindings.
const runtime = { authTeamId: config.slack.initialTeamId };

function trace(eventName, data = {}) {
  if (!config.pi.traceEnabled) return;
  const entry = { ts: new Date().toISOString(), event: eventName, ...data };
  console.log(`[pi-mom-trace] ${JSON.stringify(entry)}`);
}

function isAllowedChannel(channel) {
  if (config.slack.allowedChannelId) return channel === config.slack.allowedChannelId;
  return config.slack.allowAnyChannel;
}

async function formatStatus(client) {
  let authLine = `bot auth: not checked`;
  try {
    const auth = await client.auth.test();
    authLine = `bot auth: ${auth.user} (${auth.user_id}) on ${auth.team}`;
  } catch (error) {
    authLine = `bot auth: failed (${error?.data?.error || error.message})`;
  }

  const uptimeSeconds = Math.round((Date.now() - config.startedAt.getTime()) / 1000);
  return `*Covent Pi status*\n` +
    `• mode: \`${config.pi.mode}\`\n` +
    `• streaming: \`${config.pi.streamingEnabled ? "on" : "off"}\`\n` +
    `• uptime: \`${uptimeSeconds}s\`\n` +
    `• ${authLine}\n` +
    `• test channel target: \`#${config.slack.testChannelName}\`\n` +
    `• allowed channel: \`${config.slack.allowedChannelId || "any"}\`\n` +
    `• pi command: \`${config.pi.command}\`\n` +
    `• pi tools/extensions: \`${config.pi.allowTools ? "enabled" : "disabled"}\`\n` +
    `• image route: \`${config.image.routeEnabled ? "on" : "off"}\` (${config.image.apiKey ? config.image.model : "OPENAI_API_KEY missing"}, ${config.image.quality}, ${config.image.size})\n` +
    `• Linear issue creation: \`${config.linear.apiKey ? "configured" : "LINEAR_API_KEY missing"}\`\n` +
    `• Linear target: team \`${config.linear.teamId}\`, project \`${config.linear.projectId}\`, state \`${config.linear.stateId}\`\n` +
    `• trace: \`${config.pi.traceEnabled ? "on" : "off"}\`\n` +
    `• routes: \`${Object.keys(ROUTES).join(", ")}\``;
}

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

async function createLinearIssue({ title, description, slackUrl, requestId }) {
  if (!config.linear.apiKey) {
    throw new Error("LINEAR_API_KEY is not set in the pi-mom environment.");
  }

  const fullDescription = `${description.trim()}\n\n---\n\nSource Slack thread: ${slackUrl || "unavailable"}\nCreated by Covent Pi request: ${requestId}`;
  const query = `
    mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier title url }
      }
    }
  `;

  const response = await fetch(config.linear.apiUrl, {
    method: "POST",
    headers: {
      Authorization: config.linear.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: {
        input: {
          teamId: config.linear.teamId,
          projectId: config.linear.projectId,
          stateId: config.linear.stateId,
          title: clampLinearTitle(title),
          description: fullDescription,
        },
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.map((error) => error.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Linear issueCreate failed: ${message}`);
  }
  if (!payload.data?.issueCreate?.success || !payload.data?.issueCreate?.issue) {
    throw new Error("Linear issueCreate did not return a created issue.");
  }

  return payload.data.issueCreate.issue;
}

async function createLinearIssueFromPiOutput({ client, channel, threadTs, requestId, result }) {
  const sourceUrl = await getSlackPermalink(client, channel, threadTs);
  const { title, description } = extractLinearIssuePayload(result);

  trace("linear.issue_create_requested", {
    requestId,
    titleLength: title.length,
    descriptionLength: description.length,
    teamId: config.linear.teamId,
    projectId: config.linear.projectId,
    stateId: config.linear.stateId,
  });

  const issue = await createLinearIssue({ title, description, slackUrl: sourceUrl, requestId });
  trace("linear.issue_created", { requestId, identifier: issue.identifier, issueId: issue.id });
  return issue;
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

function formatImageSlackComment(result, { prompt, inputCount }) {
  const actionLabel = result.action === "edit" ? "edited/reference image" : "generated image";
  const safePrompt = truncateForSlack(prompt, config.slack.maxTextChars).slice(0, 1200);
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

async function handleImageRequest({ client, event, channel, threadTs, user, text, requestId, start }) {
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
      ? await collectSlackImageInputs(client, event, channel, threadTs)
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

    const comment = formatImageSlackComment(result, { prompt, inputCount: collected.inputs.length });
    const uploaded = await uploadImageResultToSlack(client, channel, threadTs, result, requestId, comment);

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
}

function streamArgsForEvent({ channel, threadTs, user, team }) {
  const teamId = team || runtime.authTeamId;
  const args = { channel, thread_ts: threadTs, buffer_size: config.pi.streamBufferChars };
  if (user && teamId) {
    args.recipient_user_id = user;
    args.recipient_team_id = teamId;
  }
  return args;
}

function piSubprocessEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SLACK_") || key.includes("SLACK") || key.startsWith("LINEAR_") || key.includes("LINEAR")) delete env[key];
  }
  return env;
}

async function runPi(prompt, { onOutput } = {}) {
  const promptDir = await mkdtemp(join(tmpdir(), "pi-mom-prompt-"));
  const promptPath = join(promptDir, "prompt.md");
  await writeFile(promptPath, prompt, { mode: 0o600 });

  try {
    return await new Promise((resolve, reject) => {
      const safeRuntimeArgs = config.pi.allowTools ? [] : ["--no-tools", "--no-extensions"];
      const args = [...config.pi.extraArgs, ...safeRuntimeArgs, "--no-session", "-p", `@${promptPath}`];
      const child = spawn(config.pi.command, args, {
        env: piSubprocessEnv(),
        cwd: config.pi.workdir,
        stdio: ["ignore", "pipe", "pipe"],
      });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let idleTimer;
    let emittedOutput = "";

    const emitNewOutput = () => {
      if (typeof onOutput !== "function") return;
      const cleanedSoFar = cleanPiOutput(stdout);
      if (cleanedSoFar === emittedOutput) return;

      const delta = cleanedSoFar.startsWith(emittedOutput)
        ? cleanedSoFar.slice(emittedOutput.length)
        : cleanedSoFar;
      emittedOutput = cleanedSoFar;

      if (!delta) return;
      try {
        onOutput(delta);
      } catch (error) {
        trace("pi.output_stream_callback_error", { error: error.message });
      }
    };

    const finish = (kind, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(timeoutTimer);

      const cleaned = stripTerminalSequences(stdout);
      if (error && kind !== "stdout_idle") {
        const message = cleaned ? `${error.message}\n\nPartial stdout:\n${cleaned}` : error.message;
        reject(new Error(message));
        return;
      }

      if (cleaned) {
        trace("pi.output_ready", { kind, outputLength: cleaned.length });
        try { child.kill("SIGTERM"); } catch {}
        resolve(cleaned);
        return;
      }

      if (error) reject(error);
      else reject(new Error(`${config.pi.command} produced no stdout. stderr: ${stripTerminalSequences(stderr)}`));
    };

    const timeoutTimer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish("timeout", new Error(`${config.pi.command} timed out after ${config.pi.timeoutMs}ms. stderr: ${stripTerminalSequences(stderr)}`));
    }, config.pi.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      emitNewOutput();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish("stdout_idle"), config.pi.outputIdleMs);
    });

    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => finish("process_error", error));
    child.on("close", (code, signal) => {
      if (code === 0) finish("process_close");
      else finish("process_close", new Error(`${config.pi.command} exited ${code ?? signal}. stderr: ${stripTerminalSequences(stderr)}`));
    });
    });
  } finally {
    await rm(promptDir, { recursive: true, force: true });
  }
}

async function runPiWithSlackStream({ client, event, channel, threadTs, user, prompt, requestId }) {
  if (typeof client.chatStream !== "function") {
    throw new Error("Slack WebClient chatStream helper is unavailable. Update @slack/web-api or disable PI_MOM_STREAMING.");
  }

  const streamArgs = streamArgsForEvent({
    channel,
    threadTs,
    user,
    team: event.team || event.team_id || event.context_team_id,
  });
  const stream = client.chatStream(streamArgs);
  let streamChain = Promise.resolve();
  let streamError = null;
  let streamedLength = 0;
  let streamVisible = false;

  const queueAppend = (text) => {
    for (const markdown_text of splitForSlackStream(text, config.pi.streamAppendChars)) {
      streamedLength += markdown_text.length;
      streamChain = streamChain
        .then(() => stream.append({ markdown_text }))
        .catch((error) => {
          streamError = streamError || error;
          trace("slack.stream_append_error", {
            requestId,
            error: error?.data?.error || error.message,
          });
        });
    }
    return streamChain;
  };

  try {
    await queueAppend(`👀 Covent Pi is thinking… (req: ${requestId})\n\n`);
    await streamChain;
    if (streamError) throw streamError;
    streamVisible = true;
    trace("slack.stream_started", {
      requestId,
      hasRecipient: Boolean(streamArgs.recipient_user_id && streamArgs.recipient_team_id),
    });

    const result = await runPi(prompt, { onOutput: queueAppend });
    await streamChain;
    if (streamError) throw streamError;
    await stream.stop();
    trace("slack.stream_stopped", { requestId, streamedLength, resultLength: result.length });
    return result;
  } catch (error) {
    if (streamVisible) {
      try {
        await queueAppend(`\n\nPi encountered an error (req: ${requestId}). Check the pi-mom terminal for details.`);
        await streamChain;
        await stream.stop();
        error.slackStreamNotified = true;
      } catch (stopError) {
        trace("slack.stream_stop_error", {
          requestId,
          error: stopError?.data?.error || stopError.message,
        });
      }
    }
    throw error;
  }
}

async function preflight() {
  const web = new WebClient(config.slack.botToken);
  const auth = await web.auth.test();
  runtime.authTeamId = auth.team_id || runtime.authTeamId;
  console.log(`🔑 Bot auth: ${auth.user} (${auth.user_id}) on ${auth.team}`);
  if (auth.user !== config.slack.expectedBotUser) {
    throw new Error(`Wrong bot token loaded. Expected ${config.slack.expectedBotUser}, got ${auth.user} on ${auth.team}.`);
  }

  const connection = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slack.appToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  }).then((r) => r.json());

  if (!connection.ok) {
    throw new Error(`SLACK_APP_TOKEN cannot open Socket Mode: ${connection.error || "unknown_error"}`);
  }
  console.log("🔌 App-level token can open Socket Mode.");
}

const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true,
  logLevel: config.slack.debug ? LogLevel.DEBUG : LogLevel.INFO,
});

app.error(async (error) => {
  console.error("[pi-mom] Bolt error", error);
});

async function handleRequest({ client, event, mode }) {
  const requestId = `req_${Date.now().toString(36)}`;
  const start = Date.now();
  const channel = event.channel;
  const user = event.user;
  const threadTs = event.thread_ts || event.ts;
  const rawText = stripBotMentions(event.text || "");
  const command = parseSlackRequestCommand(rawText, { mode });
  const text = command.text || rawText;

  trace("slack.received", {
    requestId,
    mode,
    channel,
    user,
    threadTs,
    textLength: rawText.length,
    command: command.kind,
    route: command.routeKey,
    naturalIntent: command.naturalIntent,
  });

  if (!isAllowedChannel(channel)) {
    trace("slack.ignored", { requestId, reason: "channel_not_allowed", channel, allowed: config.slack.allowedChannelId });
    return;
  }

  if (command.kind === "help") {
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: formatHelp() });
    trace("slack.replied_help", { requestId, durationMs: Date.now() - start });
    return;
  }

  if (command.kind === "status") {
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: await formatStatus(client) });
    trace("slack.replied_status", { requestId, durationMs: Date.now() - start });
    return;
  }

  if (command.requiresThread && mode === "app_mention" && !event.thread_ts) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "I can draft a spec from a thread. Reply inside the target thread with `@Covent Pi draft spec`, or use `/thread-spec <Slack message/thread URL>` as a fallback.",
    });
    trace("slack.replied_thread_required", { requestId, durationMs: Date.now() - start, route: command.routeKey });
    return;
  }

  if (config.pi.mode === "echo") {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `✅ Covent Pi event received.\nreq: ${requestId}\nmode: ${mode}\nroute: ${command.routeKey || "none"}\ntext: ${text || "(empty)"}`,
    });
    trace("slack.replied_echo", { requestId, durationMs: Date.now() - start, route: command.routeKey });
    return;
  }

  if (command.kind === "route" && command.routeKey === "image") {
    await handleImageRequest({ client, event, channel, threadTs, user, text, requestId, start });
    return;
  }

  let thinking;

  try {
    const threadContext = await getThreadContext(client, channel, threadTs);
    trace("slack.thread_context", { requestId, contextLength: threadContext.length });

    const prompt = buildPiPrompt({
      mode,
      user,
      channel,
      threadTs,
      text,
      threadContext,
      routeKey: command.routeKey,
      route: command.route,
      testChannelName: config.slack.testChannelName,
    });
    trace("pi.prompt_built", { requestId, promptLength: prompt.length, route: command.routeKey });

    if (config.pi.streamingEnabled) {
      const result = await runPiWithSlackStream({ client, event, channel, threadTs, user, prompt, requestId });
      trace("slack.replied_pi_stream", { requestId, durationMs: Date.now() - start, resultLength: result.length });
      if (command.kind === "route" && command.routeKey === "linear") {
        try {
          const issue = await createLinearIssueFromPiOutput({ client, channel, threadTs, requestId, result });
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `✅ Created Linear issue <${issue.url}|${issue.identifier}: ${issue.title}>`,
          });
          trace("slack.replied_linear_created", { requestId, identifier: issue.identifier, durationMs: Date.now() - start });
        } catch (error) {
          const message = redactSensitiveText(error?.message || String(error)).slice(0, 1200);
          trace("linear.issue_create_failed", { requestId, error: message, durationMs: Date.now() - start });
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `I drafted the issue spec, but did not create the Linear issue: ${message}`,
          });
        }
      }
      return;
    }

    thinking = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `👀 Covent Pi is thinking… (req: ${requestId})`,
    });

    const result = await runPi(prompt);
    await client.chat.update({ channel, ts: thinking.ts, text: truncateForSlack(result, config.slack.maxTextChars) });
    trace("slack.replied_pi", { requestId, durationMs: Date.now() - start, resultLength: result.length });
    if (command.kind === "route" && command.routeKey === "linear") {
      try {
        const issue = await createLinearIssueFromPiOutput({ client, channel, threadTs, requestId, result });
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `✅ Created Linear issue <${issue.url}|${issue.identifier}: ${issue.title}>`,
        });
        trace("slack.replied_linear_created", { requestId, identifier: issue.identifier, durationMs: Date.now() - start });
      } catch (error) {
        const message = redactSensitiveText(error?.message || String(error)).slice(0, 1200);
        trace("linear.issue_create_failed", { requestId, error: message, durationMs: Date.now() - start });
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `I drafted the issue spec, but did not create the Linear issue: ${message}`,
        });
      }
    }
  } catch (error) {
    trace("error", { requestId, error: error.message, durationMs: Date.now() - start });
    console.error(`[pi-mom] ${requestId} error:`, error);
    if (error.slackStreamNotified) return;

    const errorText = `Pi encountered an error (req: ${requestId}). Check the pi-mom terminal for details.`;
    if (thinking?.ts) {
      await client.chat.update({ channel, ts: thinking.ts, text: errorText });
    } else {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: errorText });
    }
  }
}

async function handleThreadSpecSlashCommand({ command, client, respond }) {
  const requestId = `cmd_${Date.now().toString(36)}`;
  const channel = command.channel_id;
  const user = command.user_id;
  const reference = parseSlackThreadReference(command.text || "");

  trace("slack.command_received", {
    requestId,
    command: command.command,
    channel,
    user,
    textLength: (command.text || "").length,
    hasThreadReference: Boolean(reference),
  });

  if (!reference) {
    await respond({
      response_type: "ephemeral",
      text: "Usage: `/thread-spec <Slack message/thread URL> [optional focus]`\n\nTip: copy the link to the root message of the thread, or any threaded reply link that includes `thread_ts`.",
    });
    trace("slack.command_replied_usage", { requestId });
    return;
  }

  const targetChannel = reference.channel || channel;
  if (!isAllowedChannel(targetChannel)) {
    await respond({
      response_type: "ephemeral",
      text: `I can only work in the configured test channel for now. Target channel: \`${targetChannel}\`; allowed channel: \`${config.slack.allowedChannelId || "any"}\`.`,
    });
    trace("slack.command_ignored", { requestId, reason: "channel_not_allowed", targetChannel, allowed: config.slack.allowedChannelId });
    return;
  }

  const focus = reference.remainingText || "Turn this Slack thread into a concise PRD/spec draft.";
  await respond({
    response_type: "ephemeral",
    text: `Working on a spec draft for <${reference.url}|this Slack thread>… (req: ${requestId})`,
  });

  await handleRequest({
    client,
    mode: "slash_command:/thread-spec",
    event: {
      channel: targetChannel,
      user,
      ts: reference.threadTs,
      thread_ts: reference.threadTs,
      text: `spec: ${focus}`,
      team: command.team_id,
      team_id: command.team_id,
    },
  });
}

app.command("/thread-spec", async ({ command, ack, client, respond }) => {
  await ack();
  await handleThreadSpecSlashCommand({ command, client, respond });
});

app.event("app_mention", async ({ event, client }) => {
  await handleRequest({ client, event, mode: "app_mention" });
});

app.message(async ({ message, client }) => {
  if (message.subtype || message.bot_id) return;
  if (message.channel_type !== "im") return;
  await handleRequest({ client, event: message, mode: "direct_message" });
});

(async () => {
  try {
    await preflight();
    await app.start();
    console.log("⚡️ Covent pi-mom is running in Socket Mode");
    console.log(`Mode: ${config.pi.mode}`);
    console.log(`Slack streaming: ${config.pi.streamingEnabled ? "enabled" : "disabled"}`);
    console.log(`Image route: ${config.image.routeEnabled ? "enabled" : "disabled"} (${config.image.apiKey ? config.image.model : "OPENAI_API_KEY missing"})`);
    console.log(`Test channel target: #${config.slack.testChannelName}`);
    console.log(`Allowed channel: ${config.slack.allowedChannelId || "any"}`);
    console.log(`📊 Tracing ${config.pi.traceEnabled ? "enabled" : "disabled"}. Look for [pi-mom-trace]`);
  } catch (error) {
    console.error(`❌ Startup failed: ${error.message}`);
    process.exit(1);
  }
})();
