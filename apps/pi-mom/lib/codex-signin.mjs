// Orchestrates the Codex (Sign in with ChatGPT) OAuth flow for one Slack
// user. Wraps `AuthStorage.login("openai-codex", callbacks)` from Pi's
// pi-coding-agent so we don't reimplement OAuth/PKCE — Pi already handles
// the authorize URL, PKCE pair, state, token exchange, refresh-token
// rotation, and persists to the user's auth.json.
//
// The integration trick: Pi's loginOpenAICodex *always* tries to bind a
// loopback HTTP server on 127.0.0.1:1455. On Railway that's harmless — the
// public Codex OAuth client has the loopback URL baked in as its only
// registered redirect, so the user's browser will land on a 1455 page that
// can't be reached from inside Slack. We bypass that by passing an
// `onManualCodeInput()` promise that resolves when the user pastes the
// failed callback URL (or just the `?code=...&state=...`) into a Slack
// modal. Pi internally races onManualCodeInput against the loopback
// callback and uses whichever fires first.
//
// Public surface:
//   startCodexSignIn({ slackUserId, onAuth, signal }) → Promise<{
//     completion: Promise<void>,  // resolves when auth.json is written
//   }>
//
// The caller (handleRequest in index.mjs) does NOT await `completion` —
// it returns control to Slack immediately. When the user submits the modal,
// `submitCodexCode(slackUserId, pasted)` is called from the view handler,
// which feeds the code back into the still-running loginOpenAICodex call.

import { getUserAuth } from "./user-auth-store.mjs";
import {
  startPending as defaultStartPending,
  resolvePending as defaultResolvePending,
  cancelPending as defaultCancelPending,
  hasPending as defaultHasPending,
} from "./oauth-pending.mjs";

export const CODEX_PROVIDER_ID = "openai-codex";

export function createCodexSignInService({
  resolveUserAuth = getUserAuth,
  startPending = defaultStartPending,
  resolvePending = defaultResolvePending,
  cancelPending = defaultCancelPending,
  hasPending = defaultHasPending,
  trace = () => {},
} = {}) {
  function startSignIn({ slackUserId, onAuth, signal } = {}) {
    if (!slackUserId) throw new Error("codex-signin: slackUserId is required");
    if (typeof onAuth !== "function") {
      throw new Error("codex-signin: onAuth callback is required");
    }

    const { authStorage } = resolveUserAuth(slackUserId);
    const codePromise = startPending(slackUserId);

    // loginOpenAICodex receives this promise and races it against the
    // loopback callback. We must invoke .login synchronously after starting
    // pending so the manual-code branch is the one selected.
    const completion = authStorage.login(CODEX_PROVIDER_ID, {
      onAuth: (info) => {
        // Pi types this as `(info) => void`. Slack post is async; fire and
        // log on failure — if it fails, the pending entry will eventually
        // expire and the user can re-mention.
        Promise.resolve()
          .then(() => onAuth(info))
          .catch((err) => {
            trace("codex_signin.onauth_post_failed", {
              user: slackUserId,
              error: err?.data?.error || err?.message || String(err),
            });
          });
      },
      onPrompt: async () => {
        // Defensive: should never fire because onManualCodeInput is set.
        // If it does (browser callback timed out AND no manual input), we
        // surface a clean error rather than hanging Slack's stdin equivalent.
        throw new Error("codex-signin: interactive prompt not supported in Slack");
      },
      onManualCodeInput: () => codePromise,
      signal,
    });

    // Translate library errors into a clean Slack-shaped message on the
    // caller side. Logging happens here; the caller decides what to DM.
    completion.then(
      () => {
        trace("codex_signin.completed", { user: slackUserId });
      },
      (err) => {
        // If completion rejects, the pending entry is already gone (Pi's
        // loginOpenAICodex consumed/cancelled it). Defensive cancel in case
        // the race finished before the entry was cleaned up.
        cancelPending(slackUserId, "completion_rejected");
        trace("codex_signin.failed", {
          user: slackUserId,
          error: err?.message || String(err),
        });
      },
    );

    return { completion };
  }

  function submitCode(slackUserId, pastedInput) {
    if (!slackUserId) return false;
    return resolvePending(slackUserId, pastedInput);
  }

  function cancel(slackUserId, reason) {
    return cancelPending(slackUserId, reason);
  }

  function isPending(slackUserId) {
    return hasPending(slackUserId);
  }

  return { startSignIn, submitCode, cancel, isPending };
}

const _defaultService = createCodexSignInService();
export const startCodexSignIn = _defaultService.startSignIn;
export const submitCodexCode = _defaultService.submitCode;
export const cancelCodexSignIn = _defaultService.cancel;
export const isCodexSignInPending = _defaultService.isPending;
