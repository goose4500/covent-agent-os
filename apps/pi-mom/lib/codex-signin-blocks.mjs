// Slack Block Kit builders for the Codex (Sign in with ChatGPT) OAuth flow.
// Three artifacts:
//   1. The first-interaction "you must sign in" message, with an
//      auth-link button and a "Paste callback URL" launcher.
//   2. The paste modal opened from the launcher button. Slack requires a
//      separate `views.open` call with a fresh trigger_id from a button
//      click — that's why the launcher exists instead of embedding the
//      input directly.
//   3. A success/error reply posted once the OAuth round-trip finishes.
//
// All `action_id`/`callback_id`/`block_id` strings live here so the Bolt
// handlers in index.mjs can import them and stay in sync with the views.

export const CODEX_SIGNIN_PASTE_ACTION_ID = "codex_signin_paste";
export const CODEX_SIGNIN_OPEN_ACTION_ID = "codex_signin_open";
export const CODEX_SIGNIN_MODAL_CALLBACK_ID = "codex_signin_modal";
export const CODEX_SIGNIN_INPUT_BLOCK_ID = "codex_signin_code";
export const CODEX_SIGNIN_INPUT_ACTION_ID = "value";

export function buildSignInMessage({ authorizeUrl, requestId } = {}) {
  if (!authorizeUrl) throw new Error("buildSignInMessage: authorizeUrl required");

  return {
    text: "Sign in with ChatGPT to start using Covent Pi",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*👋 Sign in with ChatGPT to use Covent Pi*\n\n" +
            "Covent Pi routes your requests through *your own* ChatGPT Plus/Pro " +
            "subscription. You need to sign in once — credentials are stored " +
            "per-user and rotate automatically.",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*Steps*\n" +
            "1. Click *Open ChatGPT sign-in* below.\n" +
            "2. Sign in at openai.com. Your browser will redirect to a " +
            "`localhost:1455` page that *will fail to load* — that's expected.\n" +
            "3. Copy the *entire failed URL* from the address bar (it contains " +
            "`?code=...&state=...`).\n" +
            "4. Click *Paste callback URL* and submit the URL.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🔗 Open ChatGPT sign-in" },
            url: authorizeUrl,
            action_id: CODEX_SIGNIN_OPEN_ACTION_ID,
            style: "primary",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "📋 Paste callback URL" },
            action_id: CODEX_SIGNIN_PASTE_ACTION_ID,
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_req: ${requestId || "n/a"} • this prompt expires in ~30 min_`,
          },
        ],
      },
    ],
  };
}

export function buildPasteModalView({ privateMetadata } = {}) {
  return {
    type: "modal",
    callback_id: CODEX_SIGNIN_MODAL_CALLBACK_ID,
    private_metadata: privateMetadata || "",
    title: { type: "plain_text", text: "Sign in with ChatGPT" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "Paste the *full* localhost callback URL from your browser " +
            "(`http://localhost:1455/auth/callback?code=...&state=...`), or " +
            "just the value of the `code` query parameter.",
        },
      },
      {
        type: "input",
        block_id: CODEX_SIGNIN_INPUT_BLOCK_ID,
        element: {
          type: "plain_text_input",
          action_id: CODEX_SIGNIN_INPUT_ACTION_ID,
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "http://localhost:1455/auth/callback?code=...",
          },
        },
        label: { type: "plain_text", text: "Authorization code or callback URL" },
      },
    ],
  };
}

export function buildSignInResultMessage({ ok, errorMessage, accountId } = {}) {
  if (ok) {
    return {
      text: "✅ Signed in with ChatGPT",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `✅ *Signed in with ChatGPT*${accountId ? ` (account \`${accountId}\`)` : ""}.\n\n` +
              "Mention me again to run your request — your model calls now use " +
              "your subscription.",
          },
        },
      ],
    };
  }

  return {
    text: "Sign-in failed",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "🛑 *Sign-in failed.* " +
            (errorMessage
              ? `Reason: \`${errorMessage}\`. `
              : "") +
            "Mention me again to restart the flow.",
        },
      },
    ],
  };
}

export function readPastedCodeFromView(view) {
  const value =
    view?.state?.values?.[CODEX_SIGNIN_INPUT_BLOCK_ID]?.[CODEX_SIGNIN_INPUT_ACTION_ID]?.value;
  return typeof value === "string" ? value.trim() : "";
}
