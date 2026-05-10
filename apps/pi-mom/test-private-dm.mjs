import { WebClient } from "@slack/web-api";

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error("Missing SLACK_BOT_TOKEN");
  process.exit(1);
}

const userId = process.env.SMOKE_USER_ID || process.argv[2];
if (!userId || !/^[UW][A-Z0-9]+$/.test(userId)) {
  console.error("Usage: SLACK_BOT_TOKEN=xoxb-... SMOKE_USER_ID=U0123ABC node apps/pi-mom/test-private-dm.mjs");
  console.error("       (or pass the user ID as the first CLI arg)");
  console.error("Find your user ID in Slack -> Profile -> ⋯ -> Copy member ID.");
  process.exit(1);
}

const includeEphemeral = process.env.SMOKE_SOURCE_CHANNEL && /^[CG][A-Z0-9]+$/.test(process.env.SMOKE_SOURCE_CHANNEL);

const client = new WebClient(token);

async function main() {
  const auth = await client.auth.test();
  console.log(`✅ Authenticated as: ${auth.user} (${auth.user_id}) on ${auth.team}`);

  if (userId === auth.user_id) {
    console.error("❌ SMOKE_USER_ID is the bot itself. Pass a human user ID instead.");
    process.exit(1);
  }

  console.log(`→ conversations.open users=${userId} (return_im=true)`);
  const opened = await client.conversations.open({ users: userId, return_im: true });
  if (!opened.ok || !opened.channel?.id) {
    console.error("❌ conversations.open failed:", opened.error || opened);
    process.exit(1);
  }
  const dmChannel = opened.channel.id;
  console.log(`✅ DM channel: ${dmChannel} (already_open=${Boolean(opened.already_open)}, no_op=${Boolean(opened.no_op)})`);
  if (!dmChannel.startsWith("D")) {
    console.warn(`⚠ Channel ID ${dmChannel} does not start with "D". Slack may have returned an unexpected channel type.`);
  }

  const requestId = `smoke_${Date.now().toString(36)}`;
  const anchor = await client.chat.postMessage({
    channel: dmChannel,
    text: `🔒 *Private agent loop smoke test* — req: ${requestId}\nThis verifies that Covent Pi can open a 1:1 DM with you and post into it. Reply here with \`hello\` to also smoke-test the inbound \`message.im\` path against the live bridge.`,
    unfurl_links: false,
  });
  console.log(`✅ Posted DM anchor at ts: ${anchor.ts}`);

  const followup = await client.chat.postMessage({
    channel: dmChannel,
    thread_ts: anchor.ts,
    text: "✅ Threaded follow-up — confirms `thread_ts` works in DM channels for streaming-style replies.",
    unfurl_links: false,
  });
  console.log(`✅ Posted DM threaded follow-up at ts: ${followup.ts}`);

  if (includeEphemeral) {
    const sourceChannel = process.env.SMOKE_SOURCE_CHANNEL;
    try {
      const eph = await client.chat.postEphemeral({
        channel: sourceChannel,
        user: userId,
        text: `🔒 (smoke) ephemeral redirect notice from ${sourceChannel} → DM ${dmChannel} (req: ${requestId}).`,
      });
      console.log(`✅ Posted ephemeral redirect notice in ${sourceChannel} (message_ts=${eph.message_ts}).`);
    } catch (error) {
      console.warn("⚠ chat.postEphemeral failed (probably user not in channel or bot not invited):", error?.data?.error || error.message);
    }
  } else {
    console.log("ℹ Skipping ephemeral-redirect smoke (set SMOKE_SOURCE_CHANNEL=C... to include it).");
  }

  console.log("\n✅ End-to-end private-DM bridge primitives verified.");
  console.log("Next: in Slack, test the live bridge with:");
  console.log("  • `@Covent Pi private: hello — prove the private agent loop works`");
  console.log("  • `@Covent Pi dm me a one-line gut-check`");
  console.log("  • DM `@Covent Pi` directly with any message");
}

main().catch((error) => {
  console.error("❌ Smoke test failed:", error?.data?.error || error.message);
  if (error.data) console.error(error.data);
  process.exit(1);
});
