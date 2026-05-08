import { spawnSync } from "node:child_process";
import { WebClient } from "@slack/web-api";
import { getRuntimeConfigErrors, LINEAR_DEFAULT_TARGET, REQUIRED_ENV, SLACK_TOKEN_PREFIXES, runtimeConfig } from "./lib/runtime-config.mjs";

let ok = true;
for (const error of getRuntimeConfigErrors(runtimeConfig)) {
  console.error(`✗ ${error}`);
  ok = false;
}
for (const key of REQUIRED_ENV) {
  if (!runtimeConfig.env[key]) {
    console.error(`✗ ${key} is not set`);
    ok = false;
  } else {
    const value = runtimeConfig.env[key];
    const prefix = SLACK_TOKEN_PREFIXES[key];
    console.log(`${value.startsWith(prefix) ? "✓" : "!"} ${key} is set${value.startsWith(prefix) ? "" : ` but does not start with ${prefix}`}`);
  }
}

if (runtimeConfig.slack.botToken) {
  try {
    const client = new WebClient(runtimeConfig.slack.botToken);
    const auth = await client.auth.test();
    console.log(`✓ Slack bot auth: ${auth.user} (${auth.user_id}) on ${auth.team}`);
    const expected = runtimeConfig.slack.expectedBotUser;
    if (auth.user !== expected) {
      console.error(`✗ Wrong Slack bot token loaded. Expected ${expected}, got ${auth.user}.`);
      ok = false;
    }
  } catch (error) {
    console.error(`✗ Slack auth.test failed: ${error?.data?.error || error.message}`);
    ok = false;
  }
}

if (runtimeConfig.image.apiKey) {
  console.log(`✓ OPENAI_API_KEY is set (value hidden)`);
} else {
  console.log(`! OPENAI_API_KEY is not set; @Covent Pi image: route will not call OpenAI`);
}

if (runtimeConfig.linear.apiKey) {
  console.log(`✓ LINEAR_API_KEY is set (value hidden)`);
} else {
  console.log(`! LINEAR_API_KEY is not set; @Covent Pi linear: route will draft but cannot create Linear issues`);
}

console.log(`Linear target team: ${runtimeConfig.linear.teamId || LINEAR_DEFAULT_TARGET.teamId}`);
console.log(`Linear target project: ${runtimeConfig.linear.projectId || LINEAR_DEFAULT_TARGET.projectId}`);
console.log(`Linear target state: ${runtimeConfig.linear.stateId || LINEAR_DEFAULT_TARGET.stateId}`);

console.log(`Image route: ${runtimeConfig.image.routeEnabled ? "enabled" : "disabled"}`);
console.log(`Image model: ${runtimeConfig.image.model}`);
console.log(`Image quality/size: ${runtimeConfig.image.quality}/${runtimeConfig.image.size}`);

const piCommand = runtimeConfig.pi.command;
const pi = spawnSync(piCommand, ["--version"], { encoding: "utf8" });
if (pi.error) {
  console.error(`✗ Could not run ${piCommand}: ${pi.error.message}`);
  ok = false;
} else {
  console.log(`✓ ${piCommand} is available${pi.stdout ? `: ${pi.stdout.trim()}` : ""}`);
}

console.log(`Test channel name: #${runtimeConfig.slack.testChannelName}`);
console.log(`Allowed channel ID: ${runtimeConfig.slack.allowedChannelId || "not restricted yet"}`);

process.exit(ok ? 0 : 1);
