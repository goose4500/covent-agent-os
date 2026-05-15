import assert from "node:assert/strict";
import {
  buildPiFailureSummary,
  formatPiFailureForSlack,
} from "./lib/failure-summary.mjs";

// Pi hard timeout: Slack-visible summary should be actionable, not generic.
{
  const text = formatPiFailureForSlack({
    requestId: "req_mp67tra6",
    error: new Error("Pi timed out after 180000ms"),
  });
  assert.match(text, /req_mp67tra6/);
  assert.match(text, /category: `timeout`/);
  assert.match(text, /180s bridge timeout/);
  assert.match(text, /narrower prompt/);
  assert.match(text, /Browser Use/);
}

// Browser Use auth/API-key failures are classified and secret-safe.
{
  const secret = "bu_live_super_secret_value";
  const text = formatPiFailureForSlack({
    requestId: "req_browser_auth",
    error: new Error(
      `Browser Use API 401: invalid X-Browser-Use-API-Key: ${secret}; BROWSER_USE_API_KEY=${secret}`,
    ),
  });
  assert.match(text, /req_browser_auth/);
  assert.match(text, /category: `auth`/);
  assert.match(text, /Browser Use authentication/);
  assert.doesNotMatch(text, new RegExp(secret));
  assert.doesNotMatch(text, /BROWSER_USE_API_KEY=bu_live/);
  assert.match(text, /\[REDACTED\]|bu_\[REDACTED\]/);
}

// Generic errors still get request/category/retry guidance and shared redaction.
{
  const text = formatPiFailureForSlack({
    requestId: "req_generic",
    error: new Error("unexpected failure while handling token xoxb-super-secret-token"),
  });
  const summary = buildPiFailureSummary({
    requestId: "req_generic",
    error: new Error("unexpected failure"),
  });
  assert.equal(summary.category, "unknown");
  assert.match(text, /req_generic/);
  assert.match(text, /category: `auth`|category: `unknown`/);
  assert.match(text, /try next:/);
  assert.doesNotMatch(text, /xoxb-super-secret-token/);
  assert.match(text, /xox\[REDACTED\]/);
}

console.log("failure-summary tests passed");
