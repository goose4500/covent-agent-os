export function registerRoutes(app, { handleRequest, handleThreadSpecSlashCommand }) {
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
}
