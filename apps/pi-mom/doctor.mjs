import { spawnSync } from "node:child_process";
import { WebClient } from "@slack/web-api";
import { readConfig } from "./lib/config.mjs";

const config = readConfig(process.env);
let ok = true;
for (const error of config.errors) {
  console.error(`✗ ${error}`);
  ok = false;
}
for (const warning of config.warnings) {
  console.log(`! ${warning}`);
}
for (const key of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]) {
  if (!process.env[key]) continue;
  const value = process.env[key];
  const prefix = key === "SLACK_BOT_TOKEN" ? "xoxb-" : "xapp-";
  console.log(`${value.startsWith(prefix) ? "✓" : "!"} ${key} is set${value.startsWith(prefix) ? "" : ` but does not start with ${prefix}`}`);
}

if (process.env.SLACK_BOT_TOKEN) {
  try {
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    const auth = await client.auth.test();
    console.log(`✓ Slack bot auth: ${auth.user} (${auth.user_id}) on ${auth.team}`);
    const expected = config.expectedSlackBotUser;
    if (auth.user !== expected) {
      console.error(`✗ Wrong Slack bot token loaded. Expected ${expected}, got ${auth.user}.`);
      ok = false;
    }
  } catch (error) {
    console.error(`✗ Slack auth.test failed: ${error?.data?.error || error.message}`);
    ok = false;
  }
}

if (process.env.OPENAI_API_KEY) {
  console.log(`✓ OPENAI_API_KEY is set (value hidden)`);
} else {
  console.log(`! OPENAI_API_KEY is not set; @Covent Pi image: route will not call OpenAI`);
}

if (process.env.LINEAR_API_KEY) {
  console.log(`✓ LINEAR_API_KEY is set (value hidden)`);
} else {
  console.log(`! LINEAR_API_KEY is not set; @Covent Pi linear: route will draft but cannot create Linear issues`);
}

console.log(`Linear target team: ${config.linearTeamId}`);
console.log(`Linear target project: ${config.linearProjectId}`);
console.log(`Linear target state: ${config.linearStateId}`);

console.log(`Image route: ${config.imageRouteEnabled ? "enabled" : "disabled"}`);
console.log(`Image model: ${config.imageModel}`);
console.log(`Image quality/size: ${config.imageQuality}/${config.imageSize}`);

const piCommand = config.piCommand;
const pi = spawnSync(piCommand, ["--version"], { encoding: "utf8" });
if (pi.error) {
  console.error(`✗ Could not run ${piCommand}: ${pi.error.message}`);
  ok = false;
} else {
  console.log(`✓ ${piCommand} is available${pi.stdout ? `: ${pi.stdout.trim()}` : ""}`);
}

console.log(`Test channel name: #${config.testChannelName}`);
console.log(`Allowed channel ID: ${config.allowedChannelId || "not restricted yet"}`);

process.exit(ok ? 0 : 1);
