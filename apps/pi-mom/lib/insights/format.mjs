function platformLabel(kind) {
  switch (kind) {
    case "youtube": return "YouTube";
    case "twitter": return "Twitter/X";
    case "spotify": return "Spotify";
    default: return kind;
  }
}

export function formatThreadReply({ kind, url, metadata = {}, analysis }) {
  const platform = platformLabel(kind);
  const title = metadata.title ? `*${metadata.title}*` : "*(untitled)*";
  const author = metadata.author ? ` — _${metadata.author}_` : "";
  const fallbackNote = metadata.transcriptFallbackUsed
    ? "\n_Note: full transcript unavailable; analysis used the episode description as a fallback._\n"
    : "";
  return [
    `:mag: *${platform} insight*  ${title}${author}`,
    `<${url}>`,
    fallbackNote,
    analysis.trim(),
    `_Analyzed by Covent Insights Bot._`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function formatErrorReply({ url, error, requestId }) {
  const reason = error?.message ? error.message.split("\n")[0].slice(0, 200) : "unknown error";
  return `:warning: Couldn't analyze <${url}> — ${reason} (req: ${requestId}).`;
}

export function formatMisconfigReply({ url, reason, requestId }) {
  return `:warning: Insights bot is misconfigured (${reason}) — skipped <${url}> (req: ${requestId}).`;
}
