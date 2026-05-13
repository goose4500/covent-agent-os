// Pure helpers for detecting and extracting a Codex OAuth callback paste
// from arbitrary Slack message text.
//
// Why this exists: the public Codex OAuth client (CLIENT_ID
// `app_EMoamEEZ73f0CkXaXp7hrann`) hard-codes its redirect URI to
// `http://localhost:1455/auth/callback`. We cannot host that callback on
// Railway — OpenAI's auth server only accepts the loopback URL registered
// against that client. So the user *will* always land on a dead-loading
// localhost page and we *will* always need them to copy the failed URL
// back. The only UX lever left is making the "paste" step natural: the
// user's instinct is to paste into the thread reply, not hunt for a modal
// button. This module lets the dispatcher recognize that paste.
//
// Accepted shapes (mirrors what Pi's loginOpenAICodex itself accepts via
// onManualCodeInput — full URL OR bare code):
//   1. Bare URL:      http://localhost:1455/auth/callback?code=...&state=...
//   2. https variant: https://localhost:1455/auth/callback?...
//   3. Slack auto-link wrapper: <http://localhost:1455/...|http://localhost:1455/...>
//   4. URL with surrounding chatter ("here you go: http://localhost:1455/...")
//   5. Bare code value: ac_<base64url>.<base64url>  (rare but Pi accepts it)
//
// The dispatcher uses isCodexSignInPending(user) as the *gate* — we don't
// try to feed a code into a non-pending flow. Detection here is purely
// shape-based.

const CALLBACK_HOST_PATH = "localhost:1455/auth/callback";

// Slack auto-link form: <url> or <url|display>. We need to strip the
// wrapper before further parsing, because Slack will mangle a pasted URL
// containing `?code=...&state=...` into this shape automatically.
const SLACK_LINK_RE = /<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g;

// Bare URL form. Loose on trailing punctuation so we don't accidentally
// eat a period the user typed after their paste.
const BARE_URL_RE = /https?:\/\/localhost:1455\/auth\/callback[^\s<>]*/;

// Pi's openai-codex.js calls these "auth codes". They look like
// `ac_<base64url>.<base64url>` (the dot is part of the code, not a regex
// delimiter). This regex is intentionally narrow — we don't want to
// hijack arbitrary tokens a user happens to paste.
const BARE_CODE_RE = /\bac_[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/;

export function looksLikeCodexCallback(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  if (text.includes(CALLBACK_HOST_PATH)) return true;
  if (BARE_CODE_RE.test(text)) return true;
  return false;
}

// Returns the value to feed into submitCodexCode (Pi's onManualCodeInput
// promise resolver). Preference order: full URL > bare code. Returns null
// when nothing matches.
export function extractCallbackValue(text) {
  if (typeof text !== "string" || text.length === 0) return null;

  // Unwrap any Slack auto-links so the URL becomes plain.
  const unwrapped = text.replace(SLACK_LINK_RE, (_match, url) => url);

  const urlMatch = unwrapped.match(BARE_URL_RE);
  if (urlMatch) {
    return urlMatch[0]
      // Strip common trailing punctuation a user might add after a paste.
      .replace(/[.,;:!?)\]]+$/, "");
  }

  const codeMatch = unwrapped.match(BARE_CODE_RE);
  if (codeMatch) return codeMatch[0];

  return null;
}
