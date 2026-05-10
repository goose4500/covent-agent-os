import { App, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { createOpenAIImage } from "./lib/openai-image-client.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createTrace } from "./lib/trace.mjs";
import { createSlackAdapter } from "./lib/adapters/slack.mjs";
import { createLinearAdapter } from "./lib/adapters/linear.mjs";
import { createPiRunner } from "./lib/adapters/pi-runner.mjs";
import {
  parseImageRequest,
  parseSlackRequestCommand,
  parseSlackThreadReference,
  stripBotMentions,
} from "./lib/domain/commands.mjs";
import { ROUTES } from "./lib/domain/routes.mjs";
import { redactSensitiveText } from "./lib/domain/redact.mjs";
import { formatHelp, truncateForSlack } from "./lib/domain/slack-format.mjs";
import { buildPiPrompt } from "./lib/domain/prompt.mjs";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// Runtime values discovered after startup. Single named container instead of
// free module-level `let` bindings.
const runtime = { authTeamId: config.slack.initialTeamId };

const trace = createTrace(config);
const slack = createSlackAdapter({ config, trace, getAuthTeamId: () => runtime.authTeamId });
const linear = createLinearAdapter({ config, trace, slack });
const piRunner = createPiRunner({ config, trace, slack });

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

    const comment = formatImageSlackComment(result, { prompt, inputCount: collected.inputs.length });
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
    const threadContext = await slack.getThreadContext(client, channel, threadTs);
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
      const result = await piRunner.runPiWithSlackStream({ client, event, channel, threadTs, user, prompt, requestId });
      trace("slack.replied_pi_stream", { requestId, durationMs: Date.now() - start, resultLength: result.length });
      if (command.kind === "route" && command.routeKey === "linear") {
        try {
          const issue = await linear.createLinearIssueFromPiOutput({ client, channel, threadTs, requestId, result });
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

    const result = await piRunner.runPi(prompt);
    await client.chat.update({ channel, ts: thinking.ts, text: truncateForSlack(result, config.slack.maxTextChars) });
    trace("slack.replied_pi", { requestId, durationMs: Date.now() - start, resultLength: result.length });
    if (command.kind === "route" && command.routeKey === "linear") {
      try {
        const issue = await linear.createLinearIssueFromPiOutput({ client, channel, threadTs, requestId, result });
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
