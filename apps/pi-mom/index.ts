import { App, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "./lib/config.ts";
import { createTrace } from "./lib/trace.ts";
import { createSlackAdapter } from "./lib/adapters/slack.ts";
import { createLinearAdapter } from "./lib/adapters/linear.ts";
import { createPiRunner } from "./lib/adapters/pi-runner.ts";
import { createRoutes } from "./lib/routes/index.ts";
import {
  parseSlackRequestCommand,
  parseSlackThreadReference,
  stripBotMentions,
} from "./lib/domain/commands.ts";
import { ROUTES } from "./lib/domain/routes.ts";
import { formatHelp, truncateForSlack } from "./lib/domain/slack-format.ts";
import { buildPiPrompt } from "./lib/domain/prompt.ts";

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
const routes = createRoutes({ config, trace, slack, linear });

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

async function runDefaultPiFlow({ ctx, route }) {
  const { client, event, channel, threadTs, user, text, requestId, start, mode, routeKey } = ctx;
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
      routeKey,
      route: ctx.route,
      testChannelName: config.slack.testChannelName,
    });
    trace("pi.prompt_built", { requestId, promptLength: prompt.length, route: routeKey });

    let result;
    if (config.pi.streamingEnabled) {
      result = await piRunner.runPiWithSlackStream({ client, event, channel, threadTs, user, prompt, requestId });
      trace("slack.replied_pi_stream", { requestId, durationMs: Date.now() - start, resultLength: result.length });
    } else {
      thinking = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `👀 Covent Pi is thinking… (req: ${requestId})`,
      });
      result = await piRunner.runPi(prompt);
      await client.chat.update({
        channel,
        ts: thinking.ts,
        text: truncateForSlack(result, config.slack.maxTextChars),
      });
      trace("slack.replied_pi", { requestId, durationMs: Date.now() - start, resultLength: result.length });
    }

    if (route?.postProcess) {
      await route.postProcess({ client, channel, threadTs, requestId, start, result });
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

  const route = command.kind === "route" ? routes[command.routeKey] : undefined;
  const ctx = {
    client,
    event,
    channel,
    threadTs,
    user,
    text,
    requestId,
    start,
    mode,
    routeKey: command.routeKey,
    route: command.route,
  };

  if (route?.handle) {
    await route.handle(ctx);
    return;
  }

  await runDefaultPiFlow({ ctx, route });
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
