import { spawnSync } from "node:child_process";
import { WebClient } from "@slack/web-api";

const required = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
let ok = true;
for (const key of required) {
  if (!process.env[key]) {
    console.error(`✗ ${key} is not set`);
    ok = false;
  } else {
    const value = process.env[key];
    const prefix = key === "SLACK_BOT_TOKEN" ? "xoxb-" : "xapp-";
    console.log(`${value.startsWith(prefix) ? "✓" : "!"} ${key} is set${value.startsWith(prefix) ? "" : ` but does not start with ${prefix}`}`);
  }
}

if (process.env.SLACK_BOT_TOKEN) {
  try {
    const client = new WebClient(process.env.SLACK_BOT_TOKEN);
    const auth = await client.auth.test();
    console.log(`✓ Slack bot auth: ${auth.user} (${auth.user_id}) on ${auth.team}`);
    const expected = process.env.EXPECTED_SLACK_BOT_USER || "covent_pi";
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

console.log(`Image route: ${process.env.PI_MOM_IMAGE_ROUTE_ENABLED === "false" ? "disabled" : "enabled"}`);
console.log(`Image model: ${process.env.OPENAI_IMAGE_MODEL || "gpt-image-1"}`);
console.log(`Image quality/size: ${process.env.OPENAI_IMAGE_QUALITY || "low"}/${process.env.OPENAI_IMAGE_SIZE || "1024x1024"}`);

const piCommand = process.env.PI_COMMAND || "pi";
const pi = spawnSync(piCommand, ["--version"], { encoding: "utf8" });
if (pi.error) {
  console.error(`✗ Could not run ${piCommand}: ${pi.error.message}`);
  ok = false;
} else {
  console.log(`✓ ${piCommand} is available${pi.stdout ? `: ${pi.stdout.trim()}` : ""}`);
}

console.log(`Test channel name: #${process.env.SLACK_TEST_CHANNEL_NAME || "idea-specs"}`);
console.log(`Allowed channel ID: ${process.env.SLACK_ALLOWED_CHANNEL_ID || "not restricted yet"}`);

process.exit(ok ? 0 : 1);
