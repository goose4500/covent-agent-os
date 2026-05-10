import { WebClient } from "@slack/web-api";

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error("Missing SLACK_BOT_TOKEN");
  process.exit(1);
}

const channelName = process.env.SLACK_TEST_CHANNEL_NAME || "idea-specs";
const client = new WebClient(token);

const auth = await client.auth.test();
console.log(`Authenticated as ${auth.user} on team ${auth.team}`);

let cursor;
let target;
do {
  const res = await client.conversations.list({
    types: "private_channel,public_channel",
    exclude_archived: true,
    limit: 200,
    cursor,
  });
  target = (res.channels || []).find((channel) => channel.name === channelName);
  cursor = res.response_metadata?.next_cursor;
} while (!target && cursor);

if (!target) {
  console.error(`Could not find #${channelName}. Make sure the app is invited to the private channel.`);
  process.exit(1);
}

const post = await client.chat.postMessage({
  channel: target.id,
  text: `✅ Covent Pi bridge is online in #${channelName}. Mention me in this channel to test the full Slack → Pi → Slack loop: \`@Covent Pi hello\``,
});

console.log(`Posted smoke test to #${channelName} (${target.id}) at ${post.ts}`);
