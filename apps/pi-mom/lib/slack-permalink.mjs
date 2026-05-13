// Pure parser for Slack message permalinks.
//
// Slack permalink format (May 2026):
//   https://<workspace>.slack.com/archives/<channel-id>/p<ts-no-dot>?thread_ts=<thread-ts>&cid=<channel-id>
//
//   - <channel-id> is `C…` for public/private channels, `D…` for DMs, `G…` for
//     legacy mpdms. We accept all of them.
//   - `p<digits>` encodes the message ts with the dot removed. We re-insert the
//     dot before the final 6 digits (microseconds), so `1715620000123456`
//     becomes `1715620000.123456`.
//   - If `thread_ts` query param is present, it is the parent message anchor.
//     Otherwise the message itself is top-level and acts as its own anchor.
//   - `cid` query param mirrors the channel id in the path; either is fine, but
//     the path is canonical.
//
// Defensive contract: any non-Slack URL, any missing/malformed segment, any
// parse error → return `null`. Never throw. This lets callers
// (destination-resolver) treat permalink parsing as a best-effort filter
// rather than a control-flow exception path.

/**
 * Parse a Slack permalink URL into {channel, thread_ts, message_ts}.
 *
 * @param {string} url - The candidate Slack permalink.
 * @returns {{channel: string, thread_ts: string, message_ts: string} | null}
 *   The parsed destination, or `null` if the URL is not a recognizable Slack
 *   permalink. Top-level messages have `thread_ts === message_ts`.
 */
export function parseSlackPermalink(url) {
  if (typeof url !== "string" || url.length === 0) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Only `*.slack.com` hosts. The leading subdomain is the workspace; we don't
  // pin it because workspaces vary and Slack also serves enterprise grids on
  // `app.slack.com` and similar.
  if (!/\.slack\.com$/i.test(parsed.hostname)) return null;

  // Path shape: /archives/<channel-id>/p<digits>
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "archives") return null;

  const channel = segments[1];
  if (!/^[CDG][A-Z0-9]+$/i.test(channel)) return null;

  const pSegment = segments[2];
  const pMatch = /^p(\d{7,})$/.exec(pSegment);
  if (!pMatch) return null;
  const tsDigits = pMatch[1];
  // Need at least 7 digits so the leading-seconds portion is non-empty after
  // splitting off the final 6 microsecond digits.
  if (tsDigits.length <= 6) return null;
  const message_ts = `${tsDigits.slice(0, -6)}.${tsDigits.slice(-6)}`;

  // Threaded reply: `thread_ts` query param anchors the parent message. Slack
  // serves it as `1715620000.123456` already (with the dot), so use as-is.
  const threadTsRaw = parsed.searchParams.get("thread_ts");
  const thread_ts = threadTsRaw && /^\d+\.\d+$/.test(threadTsRaw) ? threadTsRaw : message_ts;

  return { channel, thread_ts, message_ts };
}
