import { WebClient } from "@slack/web-api";

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error("Missing SLACK_BOT_TOKEN");
  process.exit(1);
}
const channelName = process.env.SLACK_TEST_CHANNEL_NAME || "idea-specs";

const client = new WebClient(token);

async function main() {
  try {
    const auth = await client.auth.test();
    console.log(`✅ Authenticated as: ${auth.user} (${auth.user_id}) on ${auth.team}`);

    let channelId = null;
    let cursor;
    do {
      const res = await client.conversations.list({
        types: "private_channel,public_channel",
        limit: 200,
        cursor,
      });
      const found = res.channels.find(c => c.name === channelName);
      if (found) {
        channelId = found.id;
        break;
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);

    if (!channelId) {
      console.error(`❌ Could not find #${channelName}. Make sure the app is installed and invited if needed.`);
      return;
    }

    console.log(`✅ Found #${channelName} (${channelId})`);

    const post = await client.chat.postMessage({
      channel: channelId,
      text: "✅ Covent Pi Web API smoke test posted successfully. This does not prove Socket Mode is listening; run `npm start` for the live bridge.",
      unfurl_links: false,
    });

    console.log(`✅ Posted smoke test at ts: ${post.ts}`);
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.data) console.error(error.data);
  }
}

main();
