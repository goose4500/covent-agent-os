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

if (process.env.LINEAR_API_KEY) {
  console.log(`✓ LINEAR_API_KEY is set (value hidden)`);
} else {
  console.log(`! LINEAR_API_KEY is not set; @Covent Pi linear: route will draft but cannot create Linear issues`);
}

console.log(`Linear target team: ${process.env.LINEAR_TEAM_ID || "c9c8376e-7fd3-4921-9996-8c98fc2274f2"}`);
console.log(`Linear target project: ${process.env.LINEAR_PROJECT_ID || "ba9682e2-c14e-4208-98a2-a89f3fb285b8"}`);
console.log(`Linear target state: ${process.env.LINEAR_STATE_ID || "adfdb6e9-b118-4d65-ada3-ad11087b7dab"}`);

if (process.env.LINEAR_WEBHOOK_SIGNING_SECRET) {
  console.log(`✓ LINEAR_WEBHOOK_SIGNING_SECRET is set (value hidden)`);
} else if (process.env.LINEAR_WEBHOOK_REQUIRED === "true") {
  console.error(`✗ LINEAR_WEBHOOK_REQUIRED=true but LINEAR_WEBHOOK_SIGNING_SECRET is not set; pi-mom will refuse to start`);
  ok = false;
} else {
  console.log(`! LINEAR_WEBHOOK_SIGNING_SECRET is not set; Linear webhook receiver will not start`);
}

if (process.env.LINEAR_WEBHOOK_SIGNING_SECRET_PREVIOUS) {
  console.log(`✓ LINEAR_WEBHOOK_SIGNING_SECRET_PREVIOUS is set (value hidden) — rotation window active`);
} else {
  console.log(`  LINEAR_WEBHOOK_SIGNING_SECRET_PREVIOUS is not set (no rotation in progress)`);
}

console.log(`Linear webhook port: ${process.env.LINEAR_WEBHOOK_PORT || "3001"}`);
console.log(`Linear webhook required (fail-fast): ${process.env.LINEAR_WEBHOOK_REQUIRED === "true" ? "true" : "false"}`);

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
