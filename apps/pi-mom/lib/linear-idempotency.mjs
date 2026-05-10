const LINEAR_URL_PATTERN = /https?:\/\/linear\.app\/[\w.-]+\/issue\/[A-Z][A-Z0-9]{1,9}-\d+[^\s>|)]*/i;
const LINEAR_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/;
const SLACK_LINK_PATTERN = /<(?<url>https?:\/\/linear\.app\/[\w.-]+\/issue\/[A-Z][A-Z0-9]{1,9}-\d+[^>|\s]*)(?:\|(?<label>[^>]+))?>/i;
const SUCCESS_CONFIRMATION_PATTERN = /^\s*(?:✅\s*)?Created Linear issue\b/i;
const NON_SUCCESS_NOTICE_PATTERN = /\b(?:did not create|not create|no Linear issue was created|LINEAR_API_KEY\s+(?:is\s+)?missing|failed|failure|error|would create|could create)\b/i;
const DRAFT_NOTICE_PATTERN = /^\s*(?:✅\s*)?Created Linear issue\s+draft\b/i;

export function extractLinearIssueReference(text = "") {
  const value = String(text || "");
  if (!SUCCESS_CONFIRMATION_PATTERN.test(value)) return undefined;
  if (NON_SUCCESS_NOTICE_PATTERN.test(value) || DRAFT_NOTICE_PATTERN.test(value)) return undefined;

  const slackLink = value.match(SLACK_LINK_PATTERN);
  if (slackLink?.groups?.url) {
    const url = slackLink.groups.url;
    const label = (slackLink.groups.label || "").trim();
    const identifier = (label.match(LINEAR_KEY_PATTERN) || url.match(LINEAR_KEY_PATTERN) || [])[0] || "";
    return {
      url,
      identifier,
      label,
      reference: `<${url}|${label || identifier || url}>`,
    };
  }

  const url = (value.match(LINEAR_URL_PATTERN) || [])[0] || "";
  const identifier = (value.match(LINEAR_KEY_PATTERN) || [])[0] || "";
  if (!url && !identifier) return undefined;

  return {
    url,
    identifier,
    label: identifier,
    reference: url && identifier ? `<${url}|${identifier}>` : (url || identifier),
  };
}

export function findPriorLinearIssueConfirmation(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] || {};
    const reference = extractLinearIssueReference(message.text || "");
    if (reference) return { ...reference, messageTs: message.ts || "" };
  }
  return undefined;
}

export function duplicateLinearIssueReply(existing) {
  const reference = existing?.reference || existing?.url || existing?.identifier || "the existing Linear issue";
  return `↩️ Linear issue already exists for this thread: ${reference}. I won’t create a duplicate.`;
}

export async function createLinearIssueUnlessDuplicate({ messages = [], createIssue, postDuplicateReply }) {
  const existing = findPriorLinearIssueConfirmation(messages);
  if (existing) {
    if (postDuplicateReply) await postDuplicateReply(existing);
    return { status: "duplicate", existing };
  }

  if (!createIssue) throw new Error("createIssue is required when no duplicate Linear issue exists.");
  const issue = await createIssue();
  return { status: "created", issue };
}
