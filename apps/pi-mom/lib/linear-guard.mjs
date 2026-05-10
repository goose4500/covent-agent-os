const LINEAR_SUCCESS_RE = /Created Linear issue\s+(?:<([^|>]+)\|)?([A-Z][A-Z0-9]+-\d+)(?::\s*([^>\n]+))?/i;
const LINEAR_URL_RE = /https:\/\/linear\.app\/[^\s>|]+\/issue\/([A-Z][A-Z0-9]+-\d+)\/[^\s>|]+/i;

export function findExistingLinearIssueConfirmation(messages = []) {
  for (const message of messages) {
    const text = String(message?.text || "");
    if (!text || /did not create the Linear issue/i.test(text)) continue;

    const success = text.match(LINEAR_SUCCESS_RE);
    if (success) {
      const url = success[1] || (text.match(LINEAR_URL_RE)?.[0] ?? "");
      return {
        identifier: success[2],
        title: (success[3] || "").trim(),
        url,
        messageTs: message.ts || "",
      };
    }

    if (/Created Linear issue/i.test(text)) {
      const urlMatch = text.match(LINEAR_URL_RE);
      if (urlMatch) {
        return {
          identifier: urlMatch[1],
          title: "",
          url: urlMatch[0],
          messageTs: message.ts || "",
        };
      }
    }
  }
  return undefined;
}

export function formatExistingLinearIssueMessage(existing) {
  if (!existing) return "";
  const label = existing.title ? `${existing.identifier}: ${existing.title}` : existing.identifier;
  const linked = existing.url ? `<${existing.url}|${label}>` : label;
  return `I found an existing Linear issue for this thread and skipped creating a duplicate: ${linked}`;
}
