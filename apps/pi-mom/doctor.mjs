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
  console.log(`! OPENAI_API_KEY is not set; OpenAI-backed Pi models will not authenticate`);
}

if (process.env.LINEAR_API_KEY) {
  console.log(`✓ LINEAR_API_KEY is set (value hidden)`);
} else {
  console.log(`! LINEAR_API_KEY is not set; @Covent Pi linear: route will draft but cannot create Linear issues`);
}

console.log(`Linear target team: ${process.env.LINEAR_TEAM_ID || "c9c8376e-7fd3-4921-9996-8c98fc2274f2"}`);
console.log(`Linear target project: ${process.env.LINEAR_PROJECT_ID || "ba9682e2-c14e-4208-98a2-a89f3fb285b8"}`);
console.log(`Linear target state: ${process.env.LINEAR_STATE_ID || "adfdb6e9-b118-4d65-ada3-ad11087b7dab"}`);

// Pi now runs embedded as the @earendil-works/pi-coding-agent SDK (not a
// subprocess), so we sanity-check that the SDK package is resolvable rather
// than that a `pi` binary is on PATH.
try {
  await import("@earendil-works/pi-coding-agent");
  console.log("✓ @earendil-works/pi-coding-agent is installed");
} catch (error) {
  console.error(`✗ @earendil-works/pi-coding-agent is not installed: ${error?.message ?? error}`);
  ok = false;
}

if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.log("! Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set; Pi will refuse to start a session in pi mode.");
}

console.log(`Test channel name: #${process.env.SLACK_TEST_CHANNEL_NAME || "idea-specs"}`);
console.log(`Allowed channel ID: ${process.env.SLACK_ALLOWED_CHANNEL_ID || "not restricted yet"}`);

process.exit(ok ? 0 : 1);
