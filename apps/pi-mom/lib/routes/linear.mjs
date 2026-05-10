import { redactSensitiveText } from "../domain/redact.mjs";

export function createLinearPostProcess({ trace, linear }) {
  return async function linearPostProcess({ client, channel, threadTs, requestId, start, result }) {
    try {
      const issue = await linear.createLinearIssueFromPiOutput({
        client,
        channel,
        threadTs,
        requestId,
        result,
      });
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `✅ Created Linear issue <${issue.url}|${issue.identifier}: ${issue.title}>`,
      });
      trace("slack.replied_linear_created", {
        requestId,
        identifier: issue.identifier,
        durationMs: Date.now() - start,
      });
    } catch (error) {
      const message = redactSensitiveText(error?.message || String(error)).slice(0, 1200);
      trace("linear.issue_create_failed", {
        requestId,
        error: message,
        durationMs: Date.now() - start,
      });
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `I drafted the issue spec, but did not create the Linear issue: ${message}`,
      });
    }
  };
}
