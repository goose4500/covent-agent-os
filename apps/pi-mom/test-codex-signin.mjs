import assert from "node:assert/strict";
import { createCodexSignInService } from "./lib/codex-signin.mjs";
import { createOAuthPendingStore } from "./lib/oauth-pending.mjs";
import {
  buildSignInMessage,
  buildPasteModalView,
  buildSignInResultMessage,
  readPastedCodeFromView,
  CODEX_SIGNIN_INPUT_BLOCK_ID,
  CODEX_SIGNIN_INPUT_ACTION_ID,
  CODEX_SIGNIN_MODAL_CALLBACK_ID,
  CODEX_SIGNIN_OPEN_ACTION_ID,
  CODEX_SIGNIN_PASTE_ACTION_ID,
} from "./views/codex-signin-blocks.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Case 1: startSignIn fires onAuth synchronously (via microtask), then
// resolves completion when the pending code is submitted. Verifies the
// full bridge: codex-signin -> oauth-pending -> AuthStorage.login.
{
  const pending = createOAuthPendingStore();
  const onAuthCalls = [];
  const loginCalls = [];
  let receivedManualPromise;

  const fakeStorage = {
    login(providerId, callbacks) {
      loginCalls.push({ providerId });
      assert.equal(providerId, "openai-codex");
      callbacks.onAuth({ url: "https://auth.openai.com/oauth/authorize?...", instructions: "open" });
      receivedManualPromise = callbacks.onManualCodeInput();
      return receivedManualPromise.then(async (code) => {
        // Simulate Pi's internal token exchange writing to auth.json.
        return undefined;
      });
    },
    hasAuth() { return false; },
  };

  const service = createCodexSignInService({
    resolveUserAuth: () => ({ authStorage: fakeStorage }),
    startPending: pending.startPending,
    resolvePending: pending.resolvePending,
    cancelPending: pending.cancelPending,
    hasPending: pending.hasPending,
  });

  const { completion } = await service.startSignIn({
    slackUserId: "U1",
    onAuth: async ({ url }) => { onAuthCalls.push(url); },
  });

  // Drain microtasks so the queued onAuth (Promise.resolve().then(...)) runs.
  await Promise.resolve(); await Promise.resolve();
  assert.equal(onAuthCalls.length, 1, "happy: onAuth received the authorize URL");
  assert.match(onAuthCalls[0], /auth\.openai\.com\/oauth\/authorize/);
  assert.equal(loginCalls.length, 1, "happy: AuthStorage.login invoked exactly once");
  assert.equal(service.isPending("U1"), true, "happy: isPending true after startSignIn");

  const ok = service.submitCode("U1", "http://localhost:1455/auth/callback?code=ABC&state=XYZ");
  assert.equal(ok, true, "happy: submitCode returns true");
  await completion;
  assert.equal(service.isPending("U1"), false, "happy: isPending false after completion");
}

// Case 2: submitCode for an unknown user is a no-op (returns false).
{
  const pending = createOAuthPendingStore();
  const service = createCodexSignInService({
    resolveUserAuth: () => ({ authStorage: { login() { return new Promise(() => {}); } } }),
    startPending: pending.startPending,
    resolvePending: pending.resolvePending,
    cancelPending: pending.cancelPending,
    hasPending: pending.hasPending,
  });
  assert.equal(service.submitCode("UNOPE", "x"), false);
}

// Case 3: completion rejection cancels the pending entry defensively.
{
  const pending = createOAuthPendingStore();
  let onAuthRan = false;
  const service = createCodexSignInService({
    resolveUserAuth: () => ({
      authStorage: {
        login(_id, callbacks) {
          callbacks.onAuth({ url: "https://x" });
          callbacks.onManualCodeInput();
          return Promise.reject(new Error("token_exchange_failed"));
        },
      },
    }),
    startPending: pending.startPending,
    resolvePending: pending.resolvePending,
    cancelPending: pending.cancelPending,
    hasPending: pending.hasPending,
  });
  const { completion } = await service.startSignIn({
    slackUserId: "U2",
    onAuth: () => { onAuthRan = true; },
  });
  await completion.catch(() => {});
  // Drain any queued .then on completion in the service.
  await Promise.resolve(); await Promise.resolve();
  assert.equal(service.isPending("U2"), false, "failure: pending entry torn down");
}

// Case 4: blocks builders shape match expected callback_id/action_id constants.
{
  const msg = buildSignInMessage({ authorizeUrl: "https://auth.openai.com/oauth/authorize?x=1", requestId: "req_abc" });
  assert.equal(msg.text, "Sign in with ChatGPT to start using Covent Pi");
  const urlButton = msg.blocks
    .flatMap((b) => b.elements || [])
    .find((e) => e?.action_id === CODEX_SIGNIN_OPEN_ACTION_ID);
  assert.ok(urlButton, "blocks: open-signin button present");
  assert.equal(urlButton.url, "https://auth.openai.com/oauth/authorize?x=1");
  const pasteButton = msg.blocks
    .flatMap((b) => b.elements || [])
    .find((e) => e?.action_id === CODEX_SIGNIN_PASTE_ACTION_ID);
  assert.ok(pasteButton, "blocks: paste button present");
  assert.ok(!pasteButton.url, "blocks: paste button has no url (opens modal via action)");

  const view = buildPasteModalView({ privateMetadata: "U1" });
  assert.equal(view.callback_id, CODEX_SIGNIN_MODAL_CALLBACK_ID);
  assert.equal(view.private_metadata, "U1");
  const inputBlock = view.blocks.find((b) => b.block_id === CODEX_SIGNIN_INPUT_BLOCK_ID);
  assert.ok(inputBlock, "modal: input block present");
  assert.equal(inputBlock.element.action_id, CODEX_SIGNIN_INPUT_ACTION_ID);

  const success = buildSignInResultMessage({ ok: true, accountId: "acct_123" });
  assert.match(success.blocks[0].text.text, /acct_123/);
  const failure = buildSignInResultMessage({ ok: false, errorMessage: "State mismatch" });
  assert.match(failure.blocks[0].text.text, /State mismatch/);
}

// Case 5: readPastedCodeFromView extracts the trimmed value, handles missing.
{
  const view = {
    state: {
      values: {
        [CODEX_SIGNIN_INPUT_BLOCK_ID]: {
          [CODEX_SIGNIN_INPUT_ACTION_ID]: { value: "  http://localhost:1455/auth/callback?code=A  " },
        },
      },
    },
  };
  assert.equal(
    readPastedCodeFromView(view),
    "http://localhost:1455/auth/callback?code=A",
  );
  assert.equal(readPastedCodeFromView({}), "");
  assert.equal(readPastedCodeFromView(null), "");
}

// Case 6: buildSignInMessage requires authorizeUrl.
{
  assert.throws(() => buildSignInMessage({}), /authorizeUrl required/);
}

console.log("✓ codex-signin: all cases pass");
