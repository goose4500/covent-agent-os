// In-process bridge between a long-running `loginOpenAICodex({ onManualCodeInput })`
// call and the eventual Slack modal submission that supplies the pasted
// authorization code.
//
// Why this exists: Pi's `loginOpenAICodex` runs entirely inside one async
// call. On a CLI it blocks waiting for paste on stdin; in Slack the paste
// arrives as a *separate* Bolt `view_submission` event minutes later. This
// module gives us a Map keyed by Slack user_id, each entry holding the
// resolve/reject of a Promise that `loginOpenAICodex` is awaiting. The Bolt
// view handler calls `resolvePending(userId, pastedInput)` to feed the code
// back into the live OAuth flow.
//
// Entries auto-expire after `ttlMs` (default 10 min) so a forgotten flow
// can't leak forever. Starting a new flow for the same user cancels any
// in-flight one — last-click-wins matches what the user expects.

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function createOAuthPendingStore({
  ttlMs = DEFAULT_TTL_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();

  function startPending(slackUserId, { state } = {}) {
    if (!slackUserId) throw new Error("oauth-pending: slackUserId is required");
    cancelPending(slackUserId, "superseded");

    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    // Attach a benign catch so a rejection without a consumer (e.g. Pi's
    // loginOpenAICodex aborting before it calls onManualCodeInput) doesn't
    // surface as an unhandled-rejection in the process. The real consumer
    // can still attach its own .catch/await and see the rejection.
    promise.catch(() => {});

    const timer = setTimeoutFn(() => {
      const entry = entries.get(slackUserId);
      if (!entry || entry.resolve !== resolveFn) return;
      entries.delete(slackUserId);
      entry.reject(new Error("oauth-pending: expired waiting for code"));
    }, ttlMs);

    entries.set(slackUserId, {
      resolve: resolveFn,
      reject: rejectFn,
      state,
      expiresAt: now() + ttlMs,
      timer,
    });
    return promise;
  }

  function resolvePending(slackUserId, pastedInput) {
    const entry = entries.get(slackUserId);
    if (!entry) return false;
    clearTimeoutFn(entry.timer);
    entries.delete(slackUserId);
    entry.resolve(pastedInput);
    return true;
  }

  function cancelPending(slackUserId, reason = "cancelled") {
    const entry = entries.get(slackUserId);
    if (!entry) return false;
    clearTimeoutFn(entry.timer);
    entries.delete(slackUserId);
    entry.reject(new Error(`oauth-pending: ${reason}`));
    return true;
  }

  function hasPending(slackUserId) {
    return entries.has(slackUserId);
  }

  function _sizeForTests() {
    return entries.size;
  }

  return { startPending, resolvePending, cancelPending, hasPending, _sizeForTests };
}

// Default process-wide store. The bot has a single Bolt app + a single
// pi-sdk-runner, so a singleton matches the existing pendingApprovals
// pattern in index.mjs. Tests instantiate their own via createOAuthPendingStore.
const _defaultStore = createOAuthPendingStore();
export const startPending = _defaultStore.startPending;
export const resolvePending = _defaultStore.resolvePending;
export const cancelPending = _defaultStore.cancelPending;
export const hasPending = _defaultStore.hasPending;
